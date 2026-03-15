import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { Destination } from '../api.js'

const TYPE_ICON: Record<string, string> = {
  rtmp: '📺',
  srt_push: '📡',
  hls: '🌐',
  recorder: '💾',
  lgl_ingest: '🔄',
  placeholder: '👻',
}

const STATUS_COLOR: Record<string, string> = {
  active: '#22c55e',
  error: '#ef4444',
  idle: '#64748b',
  placeholder: '#475569',
}

export default function DestNode({ data }: NodeProps) {
  const dest = data as unknown as Destination
  const icon = TYPE_ICON[dest.dest_type] ?? '📺'
  const color = STATUS_COLOR[dest.status] ?? '#64748b'
  const isPlaceholder = dest.dest_type === 'placeholder'

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
      {/* Input handle — left side */}
      <Handle type="target" position={Position.Left} style={{ background: color, width: 12, height: 12 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 18 }}>{icon}</span>
        <span style={{ fontWeight: 600, fontSize: 14, color: '#e2e8f0' }}>{dest.name}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
        <span style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase' }}>
          {dest.dest_type.replace('_', ' ')} · {dest.status}
        </span>
      </div>
    </div>
  )
}
