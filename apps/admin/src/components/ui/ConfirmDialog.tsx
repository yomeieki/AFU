import { create } from 'zustand'
import Modal from './Modal'
import Button from './Button'

interface ConfirmOptions {
  title: string
  content?: string
  danger?: boolean
  confirmText?: string
  cancelText?: string
}

interface ConfirmState {
  open: boolean
  options: ConfirmOptions
  resolver: ((ok: boolean) => void) | null
}

const useConfirmStore = create<ConfirmState>(() => ({
  open: false,
  options: { title: '' },
  resolver: null,
}))

// 命令式 Promise API：const ok = await confirmDialog({ title: '删除该分类？', danger: true })
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    useConfirmStore.setState({ open: true, options, resolver: resolve })
  })
}

function settle(ok: boolean) {
  const { resolver } = useConfirmStore.getState()
  useConfirmStore.setState({ open: false, resolver: null })
  resolver?.(ok)
}

export function ConfirmDialogHost() {
  const { open, options } = useConfirmStore()
  if (!open) return null
  return (
    <Modal
      title={options.title}
      width="sm"
      onClose={() => settle(false)}
      footer={
        <>
          <Button variant="secondary" onClick={() => settle(false)}>
            {options.cancelText ?? '取消'}
          </Button>
          <Button variant={options.danger ? 'danger' : 'primary'} onClick={() => settle(true)}>
            {options.confirmText ?? '确定'}
          </Button>
        </>
      }
    >
      {options.content ? <p className="text-sm text-gray-600 whitespace-pre-line">{options.content}</p> : null}
    </Modal>
  )
}
