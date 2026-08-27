import { ReactNode } from 'react'
import { PackageOpen, LucideIcon } from 'lucide-react'

interface EmptyStateProps {
  icon?: LucideIcon
  text?: string
  action?: ReactNode
}

export default function EmptyState({ icon: Icon = PackageOpen, text = '暂无数据', action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-gray-400">
      <Icon className="w-10 h-10 mb-3 text-gray-300" strokeWidth={1.5} />
      <p className="text-sm">{text}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
