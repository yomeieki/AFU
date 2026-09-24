import { ReactNode, useEffect } from 'react'
import { X } from 'lucide-react'

type Width = 'sm' | 'md' | 'lg'

interface ModalProps {
  /** 通常是字符串；用户订单弹窗需要「标题 + 小号「共 N 单」」两种字号混排，放宽成 ReactNode */
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: Width
  /** 点击遮罩 / 按 Esc 是否关闭（危险操作弹窗传 false，防误触） */
  closeOnOverlay?: boolean
}

const WIDTH: Record<Width, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
}

export default function Modal({ title, onClose, children, footer, width = 'md', closeOnOverlay = true }: ModalProps) {
  useEffect(() => {
    if (!closeOnOverlay) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, closeOnOverlay])

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 overflow-y-auto py-8"
      onClick={closeOnOverlay ? onClose : undefined}
    >
      <div
        className={`bg-white rounded-lg shadow-xl w-full ${WIDTH[width]} mx-4 my-auto max-h-[85vh] overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <h3 className="text-lg font-semibold text-gray-800">{title}</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            aria-label="关闭"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-6 pb-5">{children}</div>
        {footer && (
          <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-100">{footer}</div>
        )}
      </div>
    </div>
  )
}
