import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  Activity, Archive, ArrowUpRight, Box, Check, ChevronLeft, CloudOff, Database,
  Download, FileJson, FileSpreadsheet, Github, HardDrive, Info, LineChart as LineIcon, LockKeyhole,
  Minus, Moon, PackagePlus, Pencil, Plus, Search, Settings, ShieldCheck, ShoppingBasket,
  Sun, Trash2, TrendingDown, TrendingUp, Upload, WifiOff, X
} from 'lucide-react'
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis
} from 'recharts'
import { db, DEFAULT_SETTINGS } from './lib/db'
import type { BackupData, Product, Purchase, Store, ThemeMode } from './lib/types'
import { buildCompositeIndex, buildPointToPointChanges, categoryInflation, filterPurchases, getProductStats, lastNDaysISO, periodProductChange, sortPurchases, storeComparison } from './lib/analytics'
import { downloadText, encryptBackup, parseBackup, purchasesToCsv } from './lib/backup'
import { formatDate, formatMoney, formatMonth, formatPct, faDecimal, faNumber, todayISO } from './lib/format'
import { makeSearchKey, normalizePersianText, normalizeStoreName, sameNormalizedText } from './lib/text'
import { planBackupMerge, resolveMergeCurrency } from './lib/merge'
import { APP_VERSION, BACKUP_REMINDER_DAYS, MAX_BACKUP_FILE_BYTES } from './lib/constants'
import { startOfPersianMonthISO } from './lib/persian-date'
import { ChartTooltip } from './components/charts'
import { ProductForm, PurchaseForm } from './components/forms'
import { PersianDatePicker } from './components/date-picker'
import { Badge, ConfirmDialog, EmptyState, Modal, StatCard } from './components/ui'
import { MobileNavigation, Sidebar, type PageId } from './components/navigation'

type Toast = { id: number; text: string; kind: 'ok'|'error'|'info' }

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
}

function pctTone(value: number | null) { return value == null || value === 0 ? 'neutral' : value > 0 ? 'up' : 'down' }

type TableSortState = { column: string; direction: 'asc'|'desc' }

type InflationTableRow = {
  key: string
  kind: 'basket'|'product'
  month: string
  name: string
  product: Product | null
  previousPrice: number | null
  currentPrice: number | null
  monthlyChangePct: number | null
  yearToDateChangePct: number | null
  pointToPointChangePct: number | null
  matched: number | null
}
function TableSortHeader({ label, table, column, sort, onSort, initialDirection = 'asc' }: {
  label: string; table: string; column: string; sort?: TableSortState;
  onSort: (table: string, column: string, initialDirection: 'asc'|'desc') => void;
  initialDirection?: 'asc'|'desc'
}) {
  const active = sort?.column === column
  const direction = active ? sort.direction : null
  return <th aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}>
    <button type="button" className={`table-sort ${active ? 'is-active' : ''}`} onClick={() => onSort(table, column, initialDirection)}>
      {label}<span aria-hidden="true">{direction === 'asc' ? '▲' : direction === 'desc' ? '▼' : '↕'}</span>
    </button>
  </th>
}

export default function App() {
  const productsLive = useLiveQuery(() => db.products.toArray())
  const storesLive = useLiveQuery(() => db.stores.toArray())
  const purchasesLive = useLiveQuery(() => db.purchases.toArray())
  const transactionsLive = useLiveQuery(() => db.transactions.toArray())
  const financialSnapshotsLive = useLiveQuery(() => db.financialSnapshots.toArray())
  const settings = useLiveQuery(() => db.settings.get('main'), [], DEFAULT_SETTINGS) ?? DEFAULT_SETTINGS
  const loading = productsLive === undefined || storesLive === undefined || purchasesLive === undefined || transactionsLive === undefined || financialSnapshotsLive === undefined
  const products = productsLive ?? []
  const stores = storesLive ?? []
  const purchases = purchasesLive ?? []
  const transactions = transactionsLive ?? []
  const financialSnapshots = financialSnapshotsLive ?? []

  const [page, setPage] = useState<PageId>('dashboard')
  const [productModal, setProductModal] = useState<{open:boolean; product?:Product|null}>({open:false})
  const [purchaseModal, setPurchaseModal] = useState<{open:boolean; purchase?:Purchase|null; productId?:string}>({open:false})
  const [selectedProductId, setSelectedProductId] = useState('')
  const [toasts, setToasts] = useState<Toast[]>([])
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('همه')
  const [sortBy, setSortBy] = useState<'recent'|'change'|'name'>('recent')
  const [tableSorts, setTableSorts] = useState<Record<string, TableSortState>>({ comparison: { column: 'change', direction: 'desc' }, inflation: { column: 'month', direction: 'desc' } })
  const [comparisonExpanded, setComparisonExpanded] = useState(false)
  const toggleTableSort = (table: string, column: string, initialDirection: 'asc'|'desc' = 'asc') => {
    setTableSorts(current => {
      const previous = current[table]
      const direction = previous?.column === column ? previous.direction === 'asc' ? 'desc' : 'asc' : initialDirection
      return { ...current, [table]: { column, direction } }
    })
  }
  const sortTableRows = <T,>(table: string, rows: T[], selectors: Record<string, (row: T) => string|number|null|undefined>) => {
    const sort = tableSorts[table]
    const selector = sort ? selectors[sort.column] : undefined
    if (!sort || !selector) return rows
    const collator = new Intl.Collator('fa', { numeric: true, sensitivity: 'base' })
    return rows.slice().sort((left, right) => {
      const a = selector(left), b = selector(right)
      if (a == null && b == null) return 0
      if (a == null) return 1
      if (b == null) return -1
      const order = typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(String(a), String(b))
      return sort.direction === 'asc' ? order : -order
    })
  }
  const [rangeFrom, setRangeFrom] = useState('')
  const [rangeTo, setRangeTo] = useState(todayISO())
  const [backupPassword, setBackupPassword] = useState('')
  const [importMode, setImportMode] = useState<'replace'|'merge'>('replace')
  const [storageText, setStorageText] = useState('در حال بررسی…')
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const [confirmState, setConfirmState] = useState<{title:string; body:string; confirmText?:string; danger?:boolean} | null>(null)
  const confirmResolver = useRef<((value:boolean)=>void) | null>(null)
  const [renameTarget, setRenameTarget] = useState<Store | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const productDetailRef = useRef<HTMLElement>(null)
  const productListRef = useRef<HTMLElement>(null)

  const pushToast = (text: string, kind: Toast['kind']='ok') => {
    const id = Date.now() + Math.random()
    setToasts(t => [...t, {id, text, kind}])
    setTimeout(() => setToasts(t => t.filter(x=>x.id!==id)), 3200)
  }

  function askConfirm(title: string, body: string, confirmText = 'تأیید', danger = false) {
    return new Promise<boolean>(resolve => {
      confirmResolver.current = resolve
      setConfirmState({ title, body, confirmText, danger })
    })
  }

  function closeConfirm(result: boolean) {
    confirmResolver.current?.(result)
    confirmResolver.current = null
    setConfirmState(null)
  }

  function selectProduct(id: string, revealOnMobile = false) {
    setSelectedProductId(id)
    if (revealOnMobile && window.matchMedia('(max-width: 900px)').matches) {
      requestAnimationFrame(() => productDetailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    }
  }

  useEffect(() => {
    const handler = (event: Event) => {
      event.preventDefault()
      setInstallEvent(event as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    const apply = (mode: ThemeMode) => {
      const dark = mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
      root.dataset.theme = dark ? 'dark' : 'light'
    }
    apply(settings.theme)
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const listener = () => apply(settings.theme)
    mq.addEventListener('change', listener)
    return () => mq.removeEventListener('change', listener)
  }, [settings.theme])

  useEffect(() => {
    navigator.storage?.estimate?.().then(({usage, quota}) => {
      if (!usage || !quota) return setStorageText('ذخیره‌سازی محلی مرورگر')
      setStorageText(`${faDecimal.format(usage/1024/1024)} از ${faDecimal.format(quota/1024/1024)} مگابایت`)
    }).catch(()=>setStorageText('ذخیره‌سازی محلی مرورگر'))
  }, [purchases.length, products.length, transactions.length, financialSnapshots.length])

  useEffect(() => {
    if (loading) return
    const selected = products.find(p => p.id === selectedProductId)
    if (!selected || selected.archived) {
      setSelectedProductId(products.find(p => !p.archived)?.id ?? '')
    }
  }, [loading, products, selectedProductId])

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [page])

  const rangeInvalid = Boolean(rangeFrom && rangeTo && rangeFrom > rangeTo)
  const filteredPurchases = useMemo(() => rangeInvalid ? [] : filterPurchases(purchases, rangeFrom || undefined, rangeTo || undefined), [purchases, rangeFrom, rangeTo, rangeInvalid])
  const activeProducts = useMemo(() => products.filter(product => !product.archived), [products])
  const stats = useMemo(() => getProductStats(products, filteredPurchases), [products, filteredPurchases])
  const composite = useMemo(() => {
    if (rangeInvalid) return []
    const fromMonth = rangeFrom ? startOfPersianMonthISO(rangeFrom) : null
    const throughMonth = startOfPersianMonthISO(rangeTo || todayISO())
    return buildCompositeIndex(purchases, throughMonth)
      .filter(point => point.month <= throughMonth && (!fromMonth || point.month >= fromMonth))
  }, [purchases, rangeFrom, rangeTo, rangeInvalid])
  const latestComposite = composite.at(-1)
  const observedIndexMonths = composite.filter(point => point.hasData)
  const categories = useMemo(() => ['همه', ...Array.from(new Set(activeProducts.map(product => product.category).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'fa'))], [activeProducts])
  const normalizedSearch = useMemo(() => normalizePersianText(search), [search])
  const filteredStats = useMemo(() => {
    const rows = stats.filter(stat => {
      if (stat.product.archived) return false
      if (category !== 'همه' && stat.product.category !== category) return false
      if (!normalizedSearch) return true
      return makeSearchKey(stat.product.name, stat.product.brand, stat.product.category, stat.product.unit, stat.product.notes).includes(normalizedSearch)
    })

    return rows.sort((a, b) => {
      if (sortBy === 'name') return a.product.name.localeCompare(b.product.name, 'fa')
      if (sortBy === 'change') {
        const aChange = a.changePct == null ? -Infinity : Math.abs(a.changePct)
        const bChange = b.changePct == null ? -Infinity : Math.abs(b.changePct)
        return bChange - aChange
      }
      return (b.lastDate ?? b.product.updatedAt).localeCompare(a.lastDate ?? a.product.updatedAt)
    })
  }, [stats, normalizedSearch, category, sortBy])
  const filtersActive = Boolean(normalizedSearch) || category !== 'همه' || sortBy !== 'recent'
  const selectedProduct = products.find(product => product.id === selectedProductId)
  const selectedPurchasesAll = useMemo(() => filteredPurchases.filter(purchase => purchase.productId === selectedProductId), [filteredPurchases, selectedProductId])
  const selectedHistory = useMemo(() => sortPurchases(selectedPurchasesAll).map(purchase => ({ date: purchase.date, price: purchase.unitPrice, total: purchase.totalPaid })), [selectedPurchasesAll])
  const selectedStoreDataAll = useMemo(() => storeComparison(selectedProductId, selectedPurchasesAll, stores), [selectedProductId, selectedPurchasesAll, stores])
  const selectedNamedStores = useMemo(() => selectedStoreDataAll.filter(row => row.store !== 'بدون فروشگاه' && row.store !== 'فروشگاه حذف‌شده'), [selectedStoreDataAll])
  const selectedBestStore = selectedNamedStores.length >= 2 ? selectedNamedStores[0] : null
  const filteredProductHistory = selectedPurchasesAll
  const periodChange = periodProductChange(filteredProductHistory)
  const analyticsHistory = useMemo(() => {
    const ordered = sortPurchases(filteredProductHistory)
    return ordered.map((purchase, index) => ({
      purchase,
      changePct: index > 0 && ordered[index - 1].unitPrice > 0
        ? ((purchase.unitPrice / ordered[index - 1].unitPrice) - 1) * 100
        : null
    }))
  }, [filteredProductHistory])
  const catInflation = useMemo(() => categoryInflation(products, filteredPurchases), [products, filteredPurchases])
  const storeData = useMemo(() => storeComparison(selectedProductId, filteredPurchases, stores), [selectedProductId, filteredPurchases, stores])
  const namedStoreData = useMemo(() => storeData.filter(row => row.store !== 'بدون فروشگاه' && row.store !== 'فروشگاه حذف‌شده'), [storeData])
  const bestStore = namedStoreData.length >= 2 ? namedStoreData[0] : null
  const volatility = useMemo(() => getProductStats(activeProducts, filteredPurchases)
    .filter(stat => stat.count >= 2 && stat.volatilityPct != null)
    .sort((a, b) => (b.volatilityPct ?? 0) - (a.volatilityPct ?? 0))
    .slice(0, 8)
    .map(stat => ({ name: stat.product.name, volatility: stat.volatilityPct, count: stat.count })), [activeProducts, filteredPurchases])
  const recentStats = useMemo(() => stats
    .filter(stat => stat.count > 0 && !stat.product.archived)
    .sort((a, b) => (b.lastDate ?? '').localeCompare(a.lastDate ?? '')), [stats])
  const comparisonStats = useMemo(() => sortTableRows('comparison', recentStats, {
    name: stat => stat.product.name,
    range: stat => stat.min == null || stat.max == null ? null : stat.max - stat.min,
    change: stat => stat.changePct,
    count: stat => stat.count,
    recent: stat => stat.lastDate
  }), [recentStats, tableSorts])
  const visibleComparisonStats = comparisonExpanded ? comparisonStats : comparisonStats.slice(0, 10)
  const pointToPointMonth = useMemo(() => {
    const months = filteredPurchases
      .filter(purchase => Number.isFinite(purchase.unitPrice) && purchase.unitPrice > 0)
      .map(purchase => startOfPersianMonthISO(purchase.date))
      .sort()
    return months.at(-1) ?? null
  }, [filteredPurchases])
  const pointToPointRows = useMemo(
    () => buildPointToPointChanges(activeProducts, purchases, pointToPointMonth ?? undefined)
      .filter(row => row.previousPrice != null && row.changePct != null),
    [activeProducts, purchases, pointToPointMonth]
  )
  const combinedInflationRows: InflationTableRow[] = observedIndexMonths.slice().reverse().flatMap(point => {
    const rows: InflationTableRow[] = [{
      key: 'basket:' + point.month,
      kind: 'basket',
      month: point.month,
      name: 'سبد قیمت‌ها',
      product: null,
      previousPrice: null,
      currentPrice: null,
      monthlyChangePct: point.changePct,
      yearToDateChangePct: point.yearToDateChangePct,
      pointToPointChangePct: null,
      matched: point.yearOverYearMatched
    }]
    if (point.month === pointToPointMonth) {
      rows.push(...pointToPointRows.map(row => ({
        key: 'product:' + row.product.id,
        kind: 'product' as const,
        month: row.month,
        name: row.product.name,
        product: row.product,
        previousPrice: row.previousPrice,
        currentPrice: row.currentPrice,
        monthlyChangePct: null,
        yearToDateChangePct: null,
        pointToPointChangePct: row.changePct,
        matched: null
      })))
    }
    return rows
  })
  const sortedInflationRows = sortTableRows('inflation', combinedInflationRows, {
    month: row => row.month,
    name: row => row.name,
    previous: row => row.previousPrice,
    current: row => row.currentPrice,
    monthly: row => row.monthlyChangePct,
    yearToDate: row => row.yearToDateChangePct,
    pointToPoint: row => row.pointToPointChangePct,
    matched: row => row.matched
  })
  const money = (value: number, compact = settings.compactNumbers) => formatMoney(value, settings.currency, compact)
  const moneyValue = (value: number, compact = settings.compactNumbers) => {
    const formatted = money(value, compact)
    const currencySuffix = ` ${settings.currency}`
    return formatted.endsWith(currencySuffix) ? formatted.slice(0, -currencySuffix.length) : formatted
  }
  const lastBackupAt = settings.lastBackupAt ? new Date(settings.lastBackupAt) : null
  const backupAgeDays = lastBackupAt && !Number.isNaN(lastBackupAt.getTime()) ? Math.floor((Date.now() - lastBackupAt.getTime()) / 86_400_000) : null
  const backupDue = purchases.length >= 10 && (backupAgeDays == null || backupAgeDays >= BACKUP_REMINDER_DAYS)


  if (loading) return <div className="app-loading" role="status" aria-live="polite"><div className="loading-mark"><LineIcon size={28}/></div><strong>قیمت‌نگار</strong><span>در حال آماده‌سازی داده‌های محلی…</span><div className="loading-bar"><i/></div></div>

  function backupObject(exportedAt = new Date().toISOString()): BackupData { return { schema:'gheymat-negar', version:3, exportedAt, products, stores, purchases, transactions, financialSnapshots, settings: { ...settings, lastBackupAt: exportedAt } } }

  async function markBackup(exportedAt: string) {
    await db.settings.put({ ...settings, lastBackupAt: exportedAt })
  }

  async function plainExport() {
    const exportedAt = new Date().toISOString()
    downloadText(`gheymat-negar-backup-${todayISO()}.json`, JSON.stringify(backupObject(exportedAt), null, 2))
    await markBackup(exportedAt)
    pushToast('پشتیبان JSON ساخته شد.')
  }
  async function encryptedExport() {
    if (backupPassword.length < 8) return pushToast('برای پشتیبان رمزدار، رمزی با حداقل ۸ کاراکتر وارد کنید.', 'error')
    const exportedAt = new Date().toISOString()
    const encrypted = await encryptBackup(backupObject(exportedAt), backupPassword)
    downloadText(`gheymat-negar-backup-${todayISO()}.gheymat`, encrypted, 'application/octet-stream')
    await markBackup(exportedAt)
    setBackupPassword('')
    pushToast('پشتیبان رمزگذاری‌شده ساخته شد.')
  }
  function csvExport() {
    downloadText(`gheymat-negar-price-history-${todayISO()}.csv`, purchasesToCsv(backupObject()), 'text/csv;charset=utf-8')
    pushToast('CSV سابقه قیمت ساخته شد.')
  }

  async function importFile(file: File) {
    try {
      if (file.size > MAX_BACKUP_FILE_BYTES) throw new Error('حجم فایل پشتیبان بیشتر از ۵۰ مگابایت است و برای ورود مستقیم مناسب نیست.')
      const data = await parseBackup(await file.text(), backupPassword || undefined)
      const fileSummary = `${faNumber.format(data.products.length)} کالا، ${faNumber.format(data.purchases.length)} ثبت قیمت و ${faNumber.format(data.stores.length)} فروشگاه`
      if (importMode === 'replace') {
        if (!await askConfirm('جایگزینی داده‌های فعلی', `${fileSummary} وارد می‌شود و تمام داده‌های فعلی جایگزین خواهند شد. بهتر است قبل از ادامه از داده فعلی خروجی بگیرید.`, 'جایگزین کن', true)) return
        await db.transaction('rw', [db.products, db.stores, db.purchases, db.transactions, db.financialSnapshots, db.settings], async () => {
          await Promise.all([db.products.clear(), db.stores.clear(), db.purchases.clear(), db.transactions.clear(), db.financialSnapshots.clear(), db.settings.clear()])
          await db.products.bulkAdd(data.products); await db.stores.bulkAdd(data.stores); await db.purchases.bulkAdd(data.purchases); await db.transactions.bulkAdd(data.transactions); await db.financialSnapshots.bulkAdd(data.financialSnapshots); await db.settings.put(data.settings)
        })
      } else {
        const { adoptIncomingCurrency } = resolveMergeCurrency(settings.currency, data.settings.currency, purchases.length + transactions.length + financialSnapshots.length, data.purchases.length + data.transactions.length + data.financialSnapshots.length)
        const plan = planBackupMerge({ products, stores, purchases, transactions, financialSnapshots }, data)
        const dedupeNote = plan.dedupedProducts || plan.dedupedStores
          ? ` ${faNumber.format(plan.dedupedProducts)} کالای همسان و ${faNumber.format(plan.dedupedStores)} فروشگاه هم‌نام با رکوردهای فعلی یکپارچه می‌شوند.`
          : ''
        const currencyNote = adoptIncomingCurrency ? ` چون هنوز ثبت قیمت در داده فعلی نیست، واحد پول «${data.settings.currency}» از پشتیبان پذیرفته می‌شود.` : ''
        const mergeSummary = `${fileSummary} بررسی می‌شود. رکوردهای هم‌شناسه به‌روزرسانی می‌شوند، موارد همسان ادغام و تنظیمات نمایشی فعلی حفظ می‌شود.${dedupeNote}${currencyNote}`
        if (!await askConfirm('ادغام پشتیبان', mergeSummary, 'ادغام کن')) return
        await db.transaction('rw', [db.products, db.stores, db.purchases, db.transactions, db.financialSnapshots, db.settings], async () => {
          await db.products.bulkPut(plan.productsToPut)
          await db.stores.bulkPut(plan.storesToPut)
          await db.purchases.bulkPut(plan.purchasesToPut)
          await db.transactions.bulkPut(plan.transactionsToPut)
          await db.financialSnapshots.bulkPut(plan.financialSnapshotsToPut)
          await db.settings.put({ ...settings, currency: adoptIncomingCurrency ? data.settings.currency : settings.currency, lastBackupAt: undefined })
        })
      }
      setBackupPassword('')
      pushToast(importMode === 'replace' ? 'پشتیبان جایگزین شد.' : 'داده‌های پشتیبان ادغام شدند؛ تنظیمات نمایشی فعلی حفظ شد و زمان پشتیبان برای یادآوری بعدی بازنشانی شد.')
    } catch (e) { pushToast(e instanceof Error ? e.message : 'ورود فایل ناموفق بود.', 'error') }
    finally { if (fileInputRef.current) fileInputRef.current.value = '' }
  }

  async function clearAll() {
    if (!await askConfirm('پاک کردن همه داده‌ها', 'تمام کالاها، فروشگاه‌ها و سابقه قیمت برای همیشه از این مرورگر حذف می‌شوند و این عمل برگشت‌پذیر نیست.', 'همه را پاک کن', true)) return
    await db.transaction('rw', [db.products, db.stores, db.purchases, db.transactions, db.financialSnapshots, db.settings], async()=>{ await db.financialSnapshots.clear(); await db.transactions.clear(); await db.purchases.clear(); await db.stores.clear(); await db.products.clear(); await db.settings.put({ ...settings, lastBackupAt: undefined }) })
    pushToast('همه داده‌ها پاک شدند.', 'info')
  }

  async function persistStorage() {
    if (!navigator.storage?.persist) return pushToast('مرورگر شما این قابلیت را پشتیبانی نمی‌کند.', 'error')
    const ok = await navigator.storage.persist(); pushToast(ok ? 'مرورگر اجازه نگهداری پایدار داده‌ها را داد.' : 'مرورگر اجازه ذخیره‌سازی پایدار را نداد.', ok?'ok':'info')
  }

  async function setTheme(theme: ThemeMode) { await db.settings.put({...settings, theme}) }
  function applyQuickRange(days?: number) { setRangeTo(todayISO()); setRangeFrom(days ? lastNDaysISO(days) : '') }
  const renderRangeFilter = () => <section className="panel filter-panel range-panel">
    <div className="panel-head"><div><h2>بازهٔ بررسی</h2><p>این بازه در داشبورد، فهرست کالاها و تحلیل‌ها یکسان اعمال می‌شود؛ شاخص روی نخستین ماه داده‌دار بازه پایه‌گذاری می‌شود.</p></div></div>
    <div className="range-controls">
      <div className="filter-grid">
        <div className="field"><span>از تاریخ</span><PersianDatePicker value={rangeFrom} onChange={setRangeFrom} max={todayISO()} allowClear ariaLabel="از تاریخ" placeholder="ابتدای بازه"/></div>
        <div className="field"><span>تا تاریخ</span><PersianDatePicker value={rangeTo} onChange={setRangeTo} max={todayISO()} allowClear ariaLabel="تا تاریخ" placeholder="پایان بازه"/></div>
      </div>
      <div className="quick-ranges" aria-label="بازه‌های سریع"><button className={rangeFrom === lastNDaysISO(30) && rangeTo === todayISO() ? 'active' : ''} onClick={() => applyQuickRange(30)}>۳۰ روز</button><button className={rangeFrom === lastNDaysISO(90) && rangeTo === todayISO() ? 'active' : ''} onClick={() => applyQuickRange(90)}>۳ ماه</button><button className={rangeFrom === lastNDaysISO(180) && rangeTo === todayISO() ? 'active' : ''} onClick={() => applyQuickRange(180)}>۶ ماه</button><button className={rangeFrom === lastNDaysISO(365) && rangeTo === todayISO() ? 'active' : ''} onClick={() => applyQuickRange(365)}>۱ سال</button><button className={!rangeFrom && rangeTo === todayISO() ? 'active' : ''} onClick={() => applyQuickRange()}>کل سابقه</button></div>
    </div>
    {rangeInvalid ? <div className="filter-error"><Info size={15}/>تاریخ شروع باید پیش از تاریخ پایان باشد.</div> : null}
  </section>

  async function deletePurchase(row: Purchase) {
    if (!await askConfirm('حذف رکورد خرید', 'این رکورد از تاریخچه قیمت حذف می‌شود.', 'حذف کن', true)) return
    await db.purchases.delete(row.id); pushToast('رکورد حذف شد.', 'info')
  }
  async function toggleArchive(product: Product) { await db.products.put({...product, archived:!product.archived, updatedAt:new Date().toISOString()}); pushToast(product.archived?'کالا از آرشیو خارج شد.':'کالا آرشیو شد.', 'info') }
  async function deleteProduct(product: Product) {
    const count = purchases.filter(p=>p.productId===product.id).length
    if (!await askConfirm('حذف کالا', count ? `این کالا و ${faNumber.format(count)} رکورد خرید وابسته به آن حذف می‌شوند.` : 'این کالا برای همیشه حذف می‌شود.', 'حذف کالا', true)) return
    await db.transaction('rw', [db.products, db.purchases], async()=>{ await db.purchases.where('productId').equals(product.id).delete(); await db.products.delete(product.id) }); pushToast('کالا حذف شد.', 'info')
  }

  function renameStore(store: Store) {
    setRenameTarget(store)
    setRenameValue(store.name)
  }

  async function saveStoreRename(e: FormEvent) {
    e.preventDefault()
    if (!renameTarget) return
    const name = normalizeStoreName(renameValue)
    if (!name) return pushToast('نام فروشگاه نمی‌تواند خالی باشد.', 'error')
    if (sameNormalizedText(name, renameTarget.name)) { setRenameTarget(null); return }
    if (stores.some(store => store.id !== renameTarget.id && sameNormalizedText(store.name, name))) return pushToast('فروشگاهی با این نام از قبل وجود دارد.', 'error')
    await db.stores.put({ ...renameTarget, name })
    setRenameTarget(null)
    pushToast('نام فروشگاه ویرایش شد.')
  }
  async function deleteStore(store: Store) {
    const count = purchases.filter(p => p.storeId === store.id).length
    if (!await askConfirm('حذف فروشگاه', count ? `نام «${store.name}» از ${faNumber.format(count)} خرید پاک می‌شود، اما خود خریدها باقی می‌مانند.` : `فروشگاه «${store.name}» حذف می‌شود.`, 'حذف فروشگاه', true)) return
    await db.transaction('rw', [db.stores, db.purchases], async () => { await db.purchases.where('storeId').equals(store.id).modify({ storeId: undefined }); await db.stores.delete(store.id) })
    pushToast('فروشگاه حذف شد.', 'info')
  }

  const renderDashboard = () => <>
    <div className="page-heading">
      <div>
        <span className="eyebrow">نمای کلی</span>
        <h1>داشبورد قیمت و تورم</h1>
        <p>روند تغییر قیمت‌ها و تورم سبد کالاهای شما در طول زمان.</p>
      </div>
      <div className="button-row page-heading-actions"><button className="button primary" onClick={() => setPurchaseModal({ open: true })} disabled={!activeProducts.length}><Plus size={19}/>ثبت قیمت</button><button className="button secondary" onClick={() => setProductModal({ open: true })}><PackagePlus size={18}/>کالای جدید</button></div>
    </div>

    {products.length ? renderRangeFilter() : null}

    {!products.length ? <EmptyState
      icon={<ShoppingBasket size={28}/>}
      title="از ثبت قیمت کالاها شروع کنید"
      body="برای دنبال‌کردن روند قیمت، کالاهای موردنظر را اضافه و قیمت هرکدام را در زمان‌های مختلف ثبت کنید."
      action={<button className="button primary" onClick={() => setProductModal({ open: true })}><PackagePlus size={18}/>افزودن کالا</button>}
    /> : <>
      {products.length > 0 && !activeProducts.length ? <section className="onboarding-callout">
        <div className="onboarding-icon"><Archive size={22}/></div>
        <div><strong>همه کالاها آرشیو شده‌اند</strong><span>برای ثبت قیمت تازه، یک کالای آرشیوی را برگردانید یا کالای جدید بسازید.</span></div>
        <button className="button primary small" onClick={() => setProductModal({ open: true })}>کالای جدید</button>
      </section> : null}

      {!purchases.length && activeProducts.length ? <section className="onboarding-callout">
        <div className="onboarding-icon"><Plus size={22}/></div>
        <div><strong>همه‌چیز برای شروع آماده است</strong><span>اولین قیمت را ثبت کنید؛ با ثبت‌های بعدی، روند و درصد تغییر هر کالا شکل می‌گیرد.</span></div>
        <button className="button primary small" onClick={() => setPurchaseModal({ open: true })}>ثبت اولین قیمت</button>
      </section> : null}

      {backupDue ? <section className="onboarding-callout backup-callout">
        <div className="onboarding-icon"><Download size={22}/></div>
        <div><strong>وقت یک پشتیبان تازه است</strong><span>{backupAgeDays == null ? 'هنوز پشتیبان کامل ثبت نشده است.' : `آخرین پشتیبان کامل حدود ${faNumber.format(backupAgeDays)} روز پیش ثبت شده است.`} داده محلی را دوره‌ای خروجی بگیرید.</span></div>
        <button className="button secondary small" onClick={() => setPage('data')}>رفتن به پشتیبان</button>
      </section> : null}

      
      <section className="panel dashboard-insight-card">
        <div className="panel-head">
          <div>
            <h2>تورم و تغییر قیمت</h2>
            <p>تورم سبد شما در هر ماه و از آغاز سال، همراه با تورم نقطه‌به‌نقطهٔ هر کالا</p>
          </div>
          {latestComposite ? <Badge tone={!latestComposite.hasData ? 'default' : latestComposite.coveragePct >= 60 ? 'info' : 'default'}>{latestComposite.hasData ? faDecimal.format(latestComposite.coveragePct) + '٪ پوشش آخرین ماه' : 'بدون ثبت این ماه'}</Badge> : <Badge tone="info">داده‌ای نداریم</Badge>}
        </div>
        {latestComposite && !latestComposite.hasData ? <div className="inline-warning"><Info size={16}/><span>در {formatMonth(latestComposite.month)} قیمتی ثبت نشده؛ برای این ماه نرخ تورم محاسبه نمی‌شود و تغییر صفر تلقی نمی‌شود.</span></div> : null}
        {latestComposite?.hasData && latestComposite.matched === 0 ? <div className="inline-warning"><Info size={16}/><span>در {formatMonth(latestComposite.month)} قیمت قابل‌مقایسه‌ای با ماه قبل ثبت نشده؛ تورم ماهانه برای این ماه محاسبه نشده است.</span></div> : null}
        {sortedInflationRows.length ? <div className="table-wrap insight-table-wrap"><table className="insight-table dashboard-inflation-table">
          <thead><tr>
            <TableSortHeader table="inflation" column="month" label="ماه / کالا" sort={tableSorts.inflation} onSort={toggleTableSort} initialDirection="desc"/>
            <TableSortHeader table="inflation" column="previous" label={`قیمت سال قبل (${settings.currency})`} sort={tableSorts.inflation} onSort={toggleTableSort}/>
            <TableSortHeader table="inflation" column="current" label={`قیمت این ماه (${settings.currency})`} sort={tableSorts.inflation} onSort={toggleTableSort}/>
            <TableSortHeader table="inflation" column="monthly" label="تورم ماهانهٔ سبد" sort={tableSorts.inflation} onSort={toggleTableSort}/>
            <TableSortHeader table="inflation" column="yearToDate" label="تورم سبد از آغاز سال" sort={tableSorts.inflation} onSort={toggleTableSort}/>
            <TableSortHeader table="inflation" column="pointToPoint" label="تورم نقطه‌به‌نقطهٔ کالا" sort={tableSorts.inflation} onSort={toggleTableSort}/>
          </tr></thead>
          <tbody>{sortedInflationRows.map(row => <tr key={row.key}>
            <td><strong>{row.kind === 'basket' ? 'سبد خرید شخصی' : row.name}</strong><small>{row.kind === 'basket' ? `${formatMonth(row.month)} · ${faNumber.format(row.matched ?? 0)} کالای مقایسه‌شده` : `${formatMonth(row.month)} · ${row.product?.category ?? ''} · ${row.product?.unit ?? ''}`}</small></td>
            <td>{row.previousPrice == null ? <span className="table-muted">—</span> : moneyValue(row.previousPrice)}</td>
            <td>{row.currentPrice == null ? <span className="table-muted">—</span> : <strong className="table-primary-number">{moneyValue(row.currentPrice)}</strong>}</td>
            <td>{row.monthlyChangePct == null ? <span className="table-muted">{row.kind === 'product' ? '—' : 'بدون مقایسه'}</span> : <span className={'delta ' + pctTone(row.monthlyChangePct)}>{formatPct(row.monthlyChangePct)}</span>}</td>
            <td>{row.yearToDateChangePct == null ? <span className="table-muted">{row.kind === 'product' ? '—' : 'دادهٔ کافی نیست'}</span> : <span className={'delta ' + pctTone(row.yearToDateChangePct)}>{formatPct(row.yearToDateChangePct)}</span>}</td>
            <td>{row.pointToPointChangePct == null ? <span className="table-muted">{row.kind === 'basket' ? '—' : 'دادهٔ هم‌ماه پارسال ندارد'}</span> : <span className={'delta ' + pctTone(row.pointToPointChangePct)}>{formatPct(row.pointToPointChangePct)}</span>}</td>
          </tr>)}</tbody>
        </table></div> : <EmptyState icon={<LineIcon size={24}/>} title="هنوز داده‌ای برای مقایسه نداریم" body="با ثبت قیمت کالاها در چند ماه، نرخ‌های سبد و مقایسهٔ نقطه‌به‌نقطه نمایش داده می‌شوند."/>}
        <div className="chart-note"><Info size={15}/><span>تورم سبد با وزن سهم هر کالا از مخارج ثبت‌شدهٔ همان ماه محاسبه می‌شود و نرخ از آغاز سال شمسی از ترکیب ماهانه‌ها به دست می‌آید. نقطه‌به‌نقطه در ردیف هر کالا، قیمت آن را با همان ماه در سال قبل می‌سنجد؛ این برآورد بر پایهٔ ثبت‌های شماست، نه آمار رسمی.</span></div>
      </section>

      <section className="panel">
        <div className="panel-head"><div><h2>مقایسهٔ قیمت کالاها</h2><p>دامنهٔ کمینه تا بیشینه و درصد تغییر در بازهٔ انتخاب‌شده</p></div><button className="text-button" onClick={() => setPage('products')}>فهرست کالاها <ChevronLeft size={16}/></button></div>
        {comparisonStats.length ? <><div className={`table-wrap comparison-table-wrap ${comparisonExpanded ? 'expanded' : ''}`}><table className="comparison-table"><thead><tr>
          <TableSortHeader table="comparison" column="name" label="کالا" sort={tableSorts.comparison} onSort={toggleTableSort}/>
          <TableSortHeader table="comparison" column="range" label={`کمینه تا بیشینه (${settings.currency})`} sort={tableSorts.comparison} onSort={toggleTableSort}/>
          <TableSortHeader table="comparison" column="change" label="تغییر بازه" sort={tableSorts.comparison} onSort={toggleTableSort} initialDirection="desc"/>
          <TableSortHeader table="comparison" column="count" label="تعداد ثبت" sort={tableSorts.comparison} onSort={toggleTableSort}/>
          <TableSortHeader table="comparison" column="recent" label="آخرین ثبت" sort={tableSorts.comparison} onSort={toggleTableSort} initialDirection="desc"/>
        </tr></thead><tbody>{visibleComparisonStats.map(stat => <tr key={stat.product.id} className="clickable" tabIndex={0} role="button" onClick={() => { selectProduct(stat.product.id); setPage('products') }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectProduct(stat.product.id); setPage('products') } }}>
          <td data-label="کالا"><strong>{stat.product.name}</strong><small>{stat.product.category} · {stat.product.unit}</small></td>
          <td data-label={`کمینه تا بیشینه (${settings.currency})`}>{stat.min == null || stat.max == null ? '—' : <>{moneyValue(stat.min)} تا {moneyValue(stat.max)}</>}</td>
          <td data-label="تغییر بازه"><span className={`delta ${pctTone(stat.changePct)}`}>{stat.changePct == null || stat.changePct === 0 ? <Minus size={15}/> : stat.changePct > 0 ? <TrendingUp size={15}/> : <TrendingDown size={15}/>} {formatPct(stat.changePct)}</span></td>
          <td data-label="تعداد ثبت">{faNumber.format(stat.count)} ثبت</td>
          <td data-label="آخرین ثبت">{stat.lastDate ? formatDate(stat.lastDate) : '—'}</td>
        </tr>)}</tbody></table></div>{comparisonStats.length > 10 ? <div className="table-more">
          <button type="button" className="table-more-button" aria-expanded={comparisonExpanded} onClick={() => setComparisonExpanded(value => !value)}>
            {comparisonExpanded ? 'نمایش ۱۰ کالای نخست' : `نمایش همهٔ ${faNumber.format(comparisonStats.length)} کالا`}
          </button>
        </div> : null}</> : <EmptyState icon={<Activity size={24}/>} title="در این بازه قیمت ثبت نشده" body="بازه را تغییر دهید یا برای کالاها قیمت ثبت کنید." action={activeProducts.length ? <button className="button primary small" onClick={() => setPurchaseModal({ open: true })}><Plus size={17}/>ثبت قیمت</button> : undefined}/>}
      </section>
    </>}
  </>

  const selectedStat = stats.find(stat => stat.product.id === selectedProductId)
  const resetProductFilters = () => { setSearch(''); setCategory('همه'); setSortBy('recent') }

  const renderProducts = () => <>
    <div className="page-heading">
      <div><span className="eyebrow">مدیریت کالا</span><h1>کالاها و تاریخچه قیمت</h1><p>واحد مقایسه هر کالا را ثابت نگه دارید تا روند و درصد تغییر قابل اتکا بماند.</p></div>
      <div className="button-row page-heading-actions"><button className="button primary" onClick={() => setPurchaseModal({ open: true, productId: selectedProduct && !selectedProduct.archived ? selectedProductId : undefined })} disabled={!activeProducts.length}><Plus size={18}/>ثبت قیمت</button><button className="button secondary" onClick={() => setProductModal({ open: true })}><PackagePlus size={18}/>کالای جدید</button></div>
    </div>

    {renderRangeFilter()}

    <div className="product-layout">
      <section ref={productListRef} className="panel product-list-panel">
        <div className="filters">
          <div className="search-box"><Search size={17}/><input value={search} onChange={event => setSearch(event.target.value)} placeholder="نام، برند، دسته یا واحد…" aria-label="جست‌وجوی کالا"/>{search ? <button className="search-clear" onClick={() => setSearch('')} aria-label="پاک کردن جست‌وجو"><X size={15}/></button> : null}</div>
          <select value={category} onChange={event => setCategory(event.target.value)} aria-label="فیلتر دسته‌بندی">{categories.map(item => <option key={item}>{item}</option>)}</select>
          <select value={sortBy} onChange={event => setSortBy(event.target.value as 'recent' | 'change' | 'name')} aria-label="مرتب‌سازی کالاها"><option value="recent">آخرین ثبت</option><option value="change">بیشترین تغییر</option><option value="name">نام کالا</option></select>
        </div>
        <div className="filter-meta"><span>{faNumber.format(filteredStats.length)} از {faNumber.format(activeProducts.length)} کالا</span>{filtersActive ? <button className="text-button" onClick={resetProductFilters}>پاک کردن فیلترها</button> : null}</div>

        <div className="product-list">
          {filteredStats.length ? filteredStats.map(stat => <button className={`product-row ${selectedProductId === stat.product.id ? 'active' : ''}`} key={stat.product.id} onClick={() => selectProduct(stat.product.id, true)}><div className="product-row-main"><span className="product-avatar">{stat.product.name.trim().charAt(0)}</span><div><strong>{stat.product.name}</strong><small>{stat.product.category} · {stat.product.unit}</small></div></div><div className="product-row-price"><strong>{stat.latest == null ? 'بدون قیمت' : money(stat.latest)}</strong><span className={`mini-delta ${pctTone(stat.changePct)}`}>{formatPct(stat.changePct)}</span></div></button>) : <EmptyState title="کالایی پیدا نشد" body="جست‌وجو یا فیلترها را تغییر دهید." action={filtersActive ? <button className="button secondary small" onClick={resetProductFilters}>حذف فیلترها</button> : <button className="button secondary small" onClick={() => setProductModal({ open: true })}>کالای جدید</button>}/>} 

          {products.some(product => product.archived) ? <details className="archive-block"><summary><Archive size={14}/>آرشیو ({faNumber.format(products.filter(product => product.archived).length)})</summary>{products.filter(product => product.archived).sort((a, b) => a.name.localeCompare(b.name, 'fa')).map(product => <div className="archived-row" key={product.id}><span>{product.name}</span><button className="text-button" onClick={() => toggleArchive(product)}>بازگردانی</button></div>)}</details> : null}
        </div>
      </section>

      <section ref={productDetailRef} className="panel product-detail">
        {selectedProduct && selectedStat ? <>
          <button className="text-button mobile-list-back" onClick={() => productListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>بازگشت به فهرست کالاها</button>
          <div className="detail-head">
            <div><span className="eyebrow">{selectedProduct.category}</span><h2>{selectedProduct.name}</h2><p>{selectedProduct.brand ? `${selectedProduct.brand} · ` : ''}هر قیمت برای یک {selectedProduct.unit}</p></div>
            <div className="detail-actions"><button className="button primary small detail-buy" onClick={() => setPurchaseModal({ open: true, productId: selectedProduct.id })}><Plus size={16}/>ثبت قیمت</button><div className="kebab-row"><button className="icon-button" title="ویرایش" aria-label="ویرایش کالا" onClick={() => setProductModal({ open: true, product: selectedProduct })}><Pencil size={18}/></button><button className="icon-button" title="آرشیو" aria-label="آرشیو کالا" onClick={() => toggleArchive(selectedProduct)}><Archive size={18}/></button><button className="icon-button danger-icon" title="حذف" aria-label="حذف کالا" onClick={() => deleteProduct(selectedProduct)}><Trash2 size={18}/></button></div></div>
          </div>

          <div className="mini-stats"><div><span>ابتدای بازه</span><strong>{selectedStat.first == null ? '—' : money(selectedStat.first)}</strong></div><div><span>آخرین قیمت</span><strong>{selectedStat.latest == null ? '—' : money(selectedStat.latest)}</strong></div><div><span>کمینه</span><strong>{selectedStat.min == null ? '—' : money(selectedStat.min)}</strong></div><div><span>بیشینه</span><strong>{selectedStat.max == null ? '—' : money(selectedStat.max)}</strong></div><div><span>تغییر بازه</span><strong className={`tone-${pctTone(selectedStat.changePct)}`}>{formatPct(selectedStat.changePct)}</strong></div><div><span>تغییر مبلغ</span><strong className={`tone-${pctTone(selectedStat.changePct)}`}>{selectedStat.first == null || selectedStat.latest == null ? '—' : `${selectedStat.latest > selectedStat.first ? '+' : ''}${money(selectedStat.latest - selectedStat.first)}`}</strong></div></div>

          {selectedBestStore ? <div className="insight-strip"><ShoppingBasket size={17}/><div><strong>کمترین میانگین وزنی: {selectedBestStore.store}</strong><span>{money(selectedBestStore.avg)} · بر اساس {faNumber.format(selectedBestStore.count)} ثبت قیمت</span></div></div> : null}
          {selectedProduct.notes ? <div className="product-note"><Info size={16}/><span>{selectedProduct.notes}</span></div> : null}

          {selectedHistory.length > 1 ? <div className="chart-lg"><ResponsiveContainer width="100%" height="100%"><LineChart data={selectedHistory} margin={{ top: 6, right: 12, bottom: 10, left: 8 }}><CartesianGrid strokeDasharray="4 4" vertical={false}/><XAxis dataKey="date" tickFormatter={formatDate} tickMargin={10} minTickGap={34} interval="preserveStartEnd"/><YAxis orientation="right" tickFormatter={value => faNumber.format(Number(value))} width={76} tickMargin={8}/><Tooltip content={<ChartTooltip valueKey="price" isMoney currency={settings.currency} compactMoney={settings.compactNumbers} labelFormatter={formatDate}/>}/><Line type="monotone" dataKey="price" stroke="var(--chart-1)" strokeWidth={3} dot={{ r: 3 }} activeDot={{ r: 5 }}/></LineChart></ResponsiveContainer></div> : <EmptyState icon={<Activity size={24}/>} title="تاریخچه هنوز کوتاه است" body="بعد از ثبت دومین خرید، روند قیمت این کالا اینجا نمایش داده می‌شود." action={<button className="button primary small" onClick={() => setPurchaseModal({ open: true, productId: selectedProduct.id })}><Plus size={17}/>ثبت قیمت</button>}/>} 

          <div className="section-head"><h3>سوابق قیمت</h3><span>{faNumber.format(selectedPurchasesAll.length)} رکورد</span></div>
          <div className="history-list">{sortPurchases(selectedPurchasesAll).reverse().map(row => { const store = stores.find(item => item.id === row.storeId); return <div className="history-row" key={row.id}><div className="history-date"><strong>{formatDate(row.date)}</strong><small>{store?.name ?? 'بدون فروشگاه'}</small></div><div><strong>{money(row.unitPrice, false)}</strong><small>{faNumber.format(row.quantity)} {selectedProduct.unit} · جمع {money(row.totalPaid)}</small></div><div className="row-actions"><button className="icon-button tiny" aria-label="ویرایش ثبت قیمت" title="ویرایش ثبت قیمت" onClick={() => setPurchaseModal({ open: true, purchase: row })}><Pencil size={15}/></button><button className="icon-button tiny danger-icon" aria-label="حذف ثبت قیمت" title="حذف ثبت قیمت" onClick={() => deletePurchase(row)}><Trash2 size={15}/></button></div></div> })}</div>
        </> : <EmptyState icon={<Box size={24}/>} title="یک کالا انتخاب کنید" body="جزئیات و نمودار قیمت اینجا نشان داده می‌شود."/>}
      </section>
    </div>
  </>

  const renderAnalytics = () => <>
    <div className="page-heading"><div><span className="eyebrow">تحلیل عمیق</span><h1>تحلیل تورم و نوسان</h1><p>بازهٔ زمانی را محدود کنید و تغییر قیمت کالاها، دسته‌ها و فروشگاه‌ها را در جدول بررسی کنید.</p></div></div>

    {renderRangeFilter()}
    <section className="panel filter-panel product-analysis-filter">
      <label className="field"><span>کالا برای تحلیل جزئی</span><select value={selectedProductId} onChange={event => setSelectedProductId(event.target.value)}>{activeProducts.map(product => <option value={product.id} key={product.id}>{product.name}</option>)}</select></label>
    </section>

    <div className="stats-grid three"><StatCard label={'تغییر ' + (selectedProduct?.name ?? 'کالا')} value={formatPct(periodChange)} hint={faNumber.format(filteredProductHistory.length) + ' ثبت قیمت در این بازه'} tone={pctTone(periodChange)}/><StatCard label="ثبت‌های قیمت بازه" value={faNumber.format(filteredPurchases.length)} hint="در بازهٔ انتخاب‌شده"/><StatCard label="کالاهای دارای داده" value={faNumber.format(new Set(filteredPurchases.map(purchase => purchase.productId)).size)} hint="در بازهٔ انتخاب‌شده"/></div>

    <div className="analytics-grid analysis-table-grid">
      <section className="panel analysis-table-wide">
        <div className="panel-head"><div><h2>روند قیمت {selectedProduct?.name ?? ''}</h2><p>قیمت واحد مؤثر و تغییر آن نسبت به ثبت پیشین در بازهٔ انتخاب‌شده</p></div></div>
        {analyticsHistory.length ? <div className="table-wrap insight-table-wrap"><table className="insight-table price-history-table">
          <thead><tr>
            <TableSortHeader table="history" column="date" label="تاریخ ثبت" sort={tableSorts.history} onSort={toggleTableSort} initialDirection="desc"/>
            <TableSortHeader table="history" column="price" label="قیمت هر واحد" sort={tableSorts.history} onSort={toggleTableSort}/>
            <TableSortHeader table="history" column="change" label="تغییر با ثبت پیشین" sort={tableSorts.history} onSort={toggleTableSort}/>
            <TableSortHeader table="history" column="store" label="فروشگاه" sort={tableSorts.history} onSort={toggleTableSort}/>
          </tr></thead>
          <tbody>{sortTableRows('history', analyticsHistory.slice().reverse(), {
            date: row => row.purchase.date,
            price: row => row.purchase.unitPrice,
            change: row => row.changePct,
            store: row => row.purchase.storeId ? stores.find(store => store.id === row.purchase.storeId)?.name ?? 'فروشگاه حذف‌شده' : 'بدون فروشگاه'
          }).map(({ purchase, changePct }) => <tr key={purchase.id}>
            <td>{formatDate(purchase.date)}</td>
            <td><strong className="table-primary-number">{money(purchase.unitPrice)}</strong></td>
            <td>{changePct == null ? <span className="table-muted">مبنای بازه</span> : <span className={'delta ' + pctTone(changePct)}>{formatPct(changePct)}</span>}</td>
            <td>{purchase.storeId ? stores.find(store => store.id === purchase.storeId)?.name ?? 'فروشگاه حذف‌شده' : 'بدون فروشگاه'}</td>
          </tr>)}</tbody>
        </table></div> : <EmptyState title="داده‌ای در این بازه نیست" body="برای مشاهدهٔ روند، کالا و بازهٔ دیگری انتخاب کنید."/>}
      </section>

      <section className="panel">
        <div className="panel-head"><div><h2>تورم دسته‌ها</h2><p>تغییر مرکب کالاهای هر دسته بر اساس سهم هزینه در بازهٔ انتخابی</p></div></div>
        {catInflation.length ? <div className="table-wrap insight-table-wrap"><table className="insight-table compact-insight-table">
          <thead><tr>
            <TableSortHeader table="category" column="category" label="دسته‌بندی" sort={tableSorts.category} onSort={toggleTableSort}/>
            <TableSortHeader table="category" column="change" label="تغییر قیمت" sort={tableSorts.category} onSort={toggleTableSort} initialDirection="desc"/>
            <TableSortHeader table="category" column="products" label="تعداد کالا" sort={tableSorts.category} onSort={toggleTableSort}/>
          </tr></thead>
          <tbody>{sortTableRows('category', catInflation, { category: row => row.category, change: row => row.change, products: row => row.products }).map(row => <tr key={row.category}>
            <td>{row.category}</td><td><span className={'delta ' + pctTone(row.change)}>{formatPct(row.change)}</span></td><td>{faNumber.format(row.products)}</td>
          </tr>)}</tbody>
        </table></div> : <EmptyState title="دادهٔ کافی نیست" body="حداقل دو قیمت برای کالاهای یک دسته ثبت کنید."/>}
      </section>

      <section className="panel">
        <div className="panel-head"><div><h2>نوسان قیمت کالاها</h2><p>شدت متوسط تغییر میان ثبت‌های متوالی؛ عدد بیشتر یعنی قیمت ناپایدارتر</p></div></div>
        {volatility.length ? <div className="table-wrap insight-table-wrap"><table className="insight-table compact-insight-table">
          <thead><tr>
            <TableSortHeader table="volatility" column="name" label="کالا" sort={tableSorts.volatility} onSort={toggleTableSort}/>
            <TableSortHeader table="volatility" column="volatility" label="نوسان" sort={tableSorts.volatility} onSort={toggleTableSort} initialDirection="desc"/>
            <TableSortHeader table="volatility" column="count" label="تعداد ثبت" sort={tableSorts.volatility} onSort={toggleTableSort}/>
          </tr></thead>
          <tbody>{sortTableRows('volatility', volatility, { name: row => row.name, volatility: row => row.volatility, count: row => row.count }).map(row => <tr key={row.name}>
            <td>{row.name}</td><td><strong className="table-primary-number">{formatPct(row.volatility)}</strong></td><td>{faNumber.format(row.count)}</td>
          </tr>)}</tbody>
        </table></div> : <EmptyState title="دادهٔ کافی نیست" body="برای سنجش نوسان به چند ثبت متوالی نیاز است."/>}
      </section>

      <section className="panel analysis-table-wide">
        <div className="panel-head"><div><h2>مقایسهٔ فروشگاه‌ها</h2><p>میانگین وزنی قیمت {selectedProduct?.name ?? 'کالای انتخابی'} در هر فروشگاه</p></div>{bestStore ? <Badge tone="success">کمترین میانگین: {bestStore.store}</Badge> : null}</div>
        {storeData.length ? <div className="table-wrap insight-table-wrap"><table className="insight-table store-comparison-table">
          <thead><tr>
            <TableSortHeader table="stores" column="store" label="فروشگاه" sort={tableSorts.stores} onSort={toggleTableSort}/>
            <TableSortHeader table="stores" column="avg" label="میانگین وزنی" sort={tableSorts.stores} onSort={toggleTableSort}/>
            <TableSortHeader table="stores" column="latest" label="آخرین قیمت" sort={tableSorts.stores} onSort={toggleTableSort}/>
            <TableSortHeader table="stores" column="range" label="کمینه تا بیشینه" sort={tableSorts.stores} onSort={toggleTableSort}/>
            <TableSortHeader table="stores" column="count" label="تعداد ثبت" sort={tableSorts.stores} onSort={toggleTableSort}/>
          </tr></thead>
          <tbody>{sortTableRows('stores', storeData, {
            store: row => row.store, avg: row => row.avg, latest: row => row.latest,
            range: row => row.max - row.min, count: row => row.count
          }).map(row => <tr key={row.store}>
            <td>{row.store}</td><td><strong className="table-primary-number">{money(row.avg)}</strong></td><td>{money(row.latest)}</td><td>{money(row.min)} – {money(row.max)}</td><td>{faNumber.format(row.count)}</td>
          </tr>)}</tbody>
        </table></div> : <EmptyState title="فروشگاهی ثبت نشده" body="هنگام ثبت قیمت نام فروشگاه را وارد کنید تا این مقایسه ساخته شود."/>}
      </section>
    </div>
  </>

  const renderData = () => <>
    <div className="page-heading"><div><span className="eyebrow">کنترل داده</span><h1>داده، حریم خصوصی و تنظیمات</h1><p>داده‌های عملیاتی داخل مرورگر نگه‌داری می‌شوند؛ اپ بک‌اند، حساب کاربری یا ابزار رهگیری ندارد.</p></div></div>
    <div className="settings-grid">
      <section className="panel">
        <div className="settings-title"><div className="settings-icon"><ShieldCheck size={22}/></div><div><h2>حریم خصوصی و آفلاین</h2><p>بعد از اولین بارگذاری نسخه نهایی، فایل‌های اپ برای استفاده آفلاین در مرورگر نگه‌داری می‌شوند.</p></div></div>
        <div className="settings-list"><div><span><CloudOff size={17}/>ارسال داده کاربر</span><strong>ندارد</strong></div><div><span><HardDrive size={17}/>محل داده</span><strong>IndexedDB مرورگر</strong></div><div><span><WifiOff size={17}/>حالت آفلاین</span><strong>{import.meta.env.DEV ? 'در حالت توسعه غیرفعال است' : navigator.serviceWorker?.controller ? 'فعال' : ('serviceWorker' in navigator ? 'در حال آماده‌سازی' : 'پشتیبانی مرورگر محدود است')}</strong></div><div><span><Database size={17}/>فضای فعلی</span><strong>{storageText}</strong></div><div><span><Info size={17}/>نسخه اپ</span><strong>{APP_VERSION}</strong></div><div><span><Download size={17}/>آخرین پشتیبان کامل</span><strong>{lastBackupAt && !Number.isNaN(lastBackupAt.getTime()) ? lastBackupAt.toLocaleDateString('fa-IR-u-ca-persian') : 'ثبت نشده'}</strong></div></div>
        <div className="button-row settings-actions"><button className="button secondary" onClick={persistStorage}><HardDrive size={18}/>درخواست ذخیره‌سازی پایدار</button>{installEvent ? <button className="button primary" onClick={async () => { await installEvent.prompt(); setInstallEvent(null) }}><Download size={18}/>نصب اپ</button> : null}</div>
        <div className="notice"><Info size={17}/><span>IndexedDB رمزگذاری سطح اپ محسوب نمی‌شود. اگر دستگاه یا پروفایل مرورگر در اختیار فرد دیگری باشد، داده محلی ممکن است قابل دسترسی باشد. برای جابه‌جایی فایل، پشتیبان رمزدار مناسب‌تر است.</span></div>
      </section>

      <section className="panel">
        <div className="settings-title"><div className="settings-icon"><LockKeyhole size={22}/></div><div><h2>پشتیبان و انتقال داده</h2><p>JSON برای بازیابی کامل، CSV برای تحلیل بیرونی و فایل رمزدار برای جابه‌جایی امن‌تر.</p></div></div>
        <label className="field"><span>رمز پشتیبان رمزدار</span><input type="password" value={backupPassword} onChange={event => setBackupPassword(event.target.value)} placeholder="حداقل ۸ کاراکتر" autoComplete="new-password"/></label>
        <div className="backup-buttons"><button className="button primary" onClick={encryptedExport}><LockKeyhole size={18}/>پشتیبان رمزدار</button><button className="button secondary" onClick={plainExport}><FileJson size={18}/>خروجی JSON</button><button className="button secondary" onClick={csvExport}><FileSpreadsheet size={18}/>خروجی CSV</button></div>
        <hr/>
        <div className="import-row"><label className="field"><span>روش ورود</span><select value={importMode} onChange={event => setImportMode(event.target.value as 'replace' | 'merge')}><option value="replace">جایگزینی کامل داده فعلی</option><option value="merge">ادغام داده‌ها و حفظ تنظیمات فعلی</option></select></label><button className="button secondary" onClick={() => fileInputRef.current?.click()}><Upload size={18}/>ورود پشتیبان</button><input ref={fileInputRef} type="file" accept=".json,.gheymat,application/json" hidden onChange={event => event.target.files?.[0] && importFile(event.target.files[0])}/></div>
      </section>

      <section className="panel">
        <div className="settings-title"><div className="settings-icon"><Sun size={22}/></div><div><h2>نمایش</h2><p>تنظیمات ظاهری روی همین دستگاه ذخیره می‌شوند.</p></div></div>
        <div className="theme-picker"><button className={settings.theme === 'system' ? 'active' : ''} onClick={() => setTheme('system')}><Settings size={18}/>سیستم</button><button className={settings.theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')}><Sun size={18}/>روشن</button><button className={settings.theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')}><Moon size={18}/>تیره</button></div>
        <label className="field"><span>واحد پول</span><input key={settings.currency} defaultValue={settings.currency} disabled={purchases.length > 0} onBlur={event => db.settings.put({ ...settings, currency: event.target.value.trim() || 'تومان' })} placeholder="تومان"/><small className="field-help">{purchases.length ? 'برای جلوگیری از برچسب‌گذاری اشتباه قیمت‌های قبلی، واحد پول پس از اولین ثبت قیمت قفل می‌شود.' : 'واحد نمایش مبالغ قیمت را پیش از شروع ثبت انتخاب کنید.'}</small></label>
        <label className="switch-row"><div><strong>نمایش اعداد فشرده</strong><small>برای کارت‌ها و نمودارها از نمایش‌هایی مثل «۱٫۲ میلیون» استفاده شود.</small></div><input type="checkbox" checked={settings.compactNumbers} onChange={event => db.settings.put({ ...settings, compactNumbers: event.target.checked })}/></label>
      </section>

      <section className="panel">
        <div className="settings-title"><div className="settings-icon"><ShoppingBasket size={22}/></div><div><h2>مدیریت فروشگاه‌ها</h2><p>نام‌های اشتباه را اصلاح کنید؛ حذف فروشگاه فقط ارتباط نام فروشگاه را از خریدها پاک می‌کند.</p></div></div>
        {stores.length ? <div className="store-list">{[...stores].sort((a, b) => a.name.localeCompare(b.name, 'fa')).map(store => <div className="store-manage-row" key={store.id}><div><strong>{store.name}</strong><small>{faNumber.format(purchases.filter(purchase => purchase.storeId === store.id).length)} خرید</small></div><div className="row-actions"><button className="icon-button tiny" onClick={() => renameStore(store)} title="ویرایش فروشگاه" aria-label="ویرایش فروشگاه"><Pencil size={15}/></button><button className="icon-button tiny danger-icon" onClick={() => deleteStore(store)} title="حذف فروشگاه" aria-label="حذف فروشگاه"><Trash2 size={15}/></button></div></div>)}</div> : <EmptyState title="فروشگاهی ثبت نشده" body="هنگام ثبت قیمت می‌توانید نام فروشگاه را بنویسید."/>}
      </section>

      <section className="panel danger-panel">
        <div className="settings-title"><div className="settings-icon"><Database size={22}/></div><div><h2>پاک‌سازی داده‌ها</h2><p>این کار همه قیمت‌ها، کالاها و فروشگاه‌های ذخیره‌شده را از این مرورگر حذف می‌کند.</p></div></div>
        <div className="button-row"><button className="button danger" onClick={clearAll}><Trash2 size={18}/>پاک کردن همه داده‌ها</button></div>
      </section>
    </div>
  </>

  const navigate = (nextPage: PageId) => {
    if (nextPage === page) {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
      return
    }
    setPage(nextPage)
  }

  return <div className="app-shell">
    <Sidebar page={page} onNavigate={navigate}/>
    <main className="main">
      <div className="page-content">
        {page==='dashboard'?renderDashboard():page==='products'?renderProducts():page==='analytics'?renderAnalytics():renderData()}
        <footer className="site-footer" aria-label="پاورقی">
          <span className="site-footer-note">قیمت‌نگار، ابزار ثبت و بررسی قیمت‌های شخصی</span>
          <a className="site-source-link" href="https://github.com/afshin-ir/gheymatnegar" target="_blank" rel="noreferrer" aria-label="مشاهدهٔ کد منبع قیمت‌نگار در GitHub">
            <Github size={16} aria-hidden="true"/>
            <span>مشاهدهٔ کد منبع</span>
            <ArrowUpRight size={14} aria-hidden="true"/>
          </a>
        </footer>
      </div>
    </main>
    <MobileNavigation page={page} onNavigate={navigate}/>

    <Modal open={productModal.open} title={productModal.product?'ویرایش کالا':'افزودن کالای جدید'} onClose={()=>setProductModal({open:false})} wide><ProductForm product={productModal.product} products={products} purchaseCount={productModal.product ? purchases.filter(row => row.productId === productModal.product!.id).length : 0} onDone={()=>setProductModal({open:false})} onCancel={()=>setProductModal({open:false})} pushToast={pushToast}/></Modal>
    <Modal open={purchaseModal.open} title={purchaseModal.purchase?'ویرایش ثبت قیمت':'ثبت قیمت جدید'} onClose={()=>setPurchaseModal({open:false})}><PurchaseForm key={`${purchaseModal.purchase?.id??'new'}-${purchaseModal.productId??''}`} products={products} stores={stores} purchase={purchaseModal.purchase} initialProductId={purchaseModal.productId} currency={settings.currency} onDone={()=>setPurchaseModal({open:false})} onCancel={()=>setPurchaseModal({open:false})} pushToast={pushToast}/></Modal>
    <Modal open={!!renameTarget} title="ویرایش نام فروشگاه" onClose={()=>setRenameTarget(null)}><form className="form-grid" onSubmit={saveStoreRename}><label className="field field-span-2"><span>نام فروشگاه</span><input autoFocus value={renameValue} onChange={e=>setRenameValue(e.target.value)} required/></label><div className="form-actions field-span-2"><button type="submit" className="button primary"><Check size={18}/>ذخیره</button><button type="button" className="button ghost" onClick={()=>setRenameTarget(null)}>انصراف</button></div></form></Modal>
    <ConfirmDialog open={!!confirmState} title={confirmState?.title??''} body={confirmState?.body??''} confirmText={confirmState?.confirmText} danger={confirmState?.danger} onClose={()=>closeConfirm(false)} onConfirm={()=>closeConfirm(true)}/>
    <div className="toast-stack" role="status" aria-live="polite" aria-atomic="true">{toasts.map(t=><div className={`toast ${t.kind}`} key={t.id}>{t.kind==='ok'?<Check size={17}/>:t.kind==='error'?<X size={17}/>:<Info size={17}/>}<span>{t.text}</span></div>)}</div>
  </div>
}
