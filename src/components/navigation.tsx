import { BarChart3, Database, Home, LineChart, ShoppingBasket } from 'lucide-react'

export const NAV_ITEMS = [
  { id: 'dashboard', label: 'داشبورد', mobileLabel: 'داشبورد', icon: Home },
  { id: 'products', label: 'کالاها', mobileLabel: 'کالاها', icon: ShoppingBasket },
  { id: 'analytics', label: 'تحلیل‌ها', mobileLabel: 'تحلیل‌ها', icon: BarChart3 },
  { id: 'data', label: 'داده و تنظیمات', mobileLabel: 'تنظیمات', icon: Database },
] as const

export type PageId = typeof NAV_ITEMS[number]['id']

type Navigate = (page: PageId) => void

export function Sidebar({ page, onNavigate }: { page: PageId; onNavigate: Navigate }) {
  return <aside className="sidebar">
    <div className="brand">
      <div className="brand-mark"><LineChart size={23}/></div>
      <div><strong>قیمت‌نگار</strong><span>رصد قیمت، بدون سرور</span></div>
    </div>
    <nav aria-label="ناوبری اصلی">{NAV_ITEMS.map(item => {
      const Icon = item.icon
      return <button key={item.id} className={page === item.id ? 'active' : ''} aria-current={page === item.id ? 'page' : undefined} onClick={() => onNavigate(item.id)}><Icon size={20}/><span>{item.label}</span></button>
    })}</nav>
  </aside>
}

export function MobileNavigation({ page, onNavigate }: { page: PageId; onNavigate: Navigate }) {
  return <nav className="mobile-nav" aria-label="ناوبری پایین صفحه">{NAV_ITEMS.map(item => {
    const Icon = item.icon
    return <button key={item.id} className={page === item.id ? 'active' : ''} aria-current={page === item.id ? 'page' : undefined} onClick={() => onNavigate(item.id)}><Icon size={19}/><span>{item.mobileLabel}</span></button>
  })}</nav>
}
