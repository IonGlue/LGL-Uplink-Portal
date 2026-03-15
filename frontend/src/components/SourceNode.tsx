import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { Source } from '../api.js'

const TYPE_ICON: Record<string, string> = {
  encoder: '📡',
  srt_listen: '🔗',
  srt_pull: '🔗',
  rtmp_pull: '📺',
  test_pattern: '🎨',
  placeholder: '👻',
}

const STATUS_COLOR: Record<string, string> = {
  active: '#22c55e',
  waiting: '#eab308',
  error: '#ef4444',
  idle: '#64748b',
  placeholder: '#475569',
}

export default function SourceNode({ data }: NodeProps) {
  const src = data as unknown as Source & { onDelete: (id: string) => void }
  const icon = TYPE_ICON[src.source_type] ?? '📡'
  const color = STATUS_COLOR[src.status] ?? '#64748b'
  const isPlaceholder = src.source_type === 'placeholder'

  return (
    <div style={{
      background: '#1e2130',
      border: `2px solid ${isPlaceholder ? '#2d3348' : color}`,
      borderStyle: isPlaceholder ? 'dashed' : 'solid',
      borderRadius: 10,
      padding: '12px 16px',
      minWidth: 200,
      position: 'relative',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 18 }}>{icon}</span>
        <span style={{ fontWeight: 600, fontSize: 14, color: '#e2e8f0' }}>{src.name}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
        <span style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase' }}>
          {src.source_type.replace('_', ' ')} · {src.status}
        </span>
      </div>
      {/* Output handle — right side */}
      <Handle type="source" position={Position.Right} style={{ background: color, width: 12, height: 12 }} />
    </div>
  )
}
