import { Capacitor, registerPlugin } from '@capacitor/core'
import { downloadText } from './backup'

export const isNativeApp = Capacitor.isNativePlatform()

const DocumentExport = registerPlugin<{
  save(options: { filename: string; text: string; mimeType: string }): Promise<{ saved: boolean }>
}>('DocumentExport')

/** Android cancellation must not mark the data as backed up. */
export async function exportText(filename: string, text: string, mimeType = 'application/json'): Promise<boolean> {
  if (isNativeApp) return (await DocumentExport.save({ filename, text, mimeType })).saved
  downloadText(filename, text, `${mimeType};charset=utf-8`)
  return true
}
