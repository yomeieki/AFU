import { CHANNEL_LABEL, type Channel } from '../../types'

export default function ChannelTabs({ value, onChange }: { value: Channel; onChange: (c: Channel) => void }) {
  return (
    <div className="flex gap-2 border-b border-gray-200">
      {(['EXPRESS', 'LOCAL'] as Channel[]).map((c) => (
        <button key={c} onClick={() => onChange(c)}
          className={`px-4 py-2 text-sm -mb-px border-b-2 ${value === c ? 'border-brand-500 text-brand-600 font-medium' : 'border-transparent text-gray-500'}`}>
          {CHANNEL_LABEL[c]}
        </button>
      ))}
    </div>
  )
}
