import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Radio, Signal, Link, Tv, Sliders, CircleDashed, type LucideIcon } from 'lucide-react'
import type { Source } from '../api.js'

const TYPE_ICON: Record<string, LucideIcon> = {
  encoder:      Radio,
  srt_listen:   Signal,
  srt_pull:     Link,
  rtmp_pull:    Tv,
  test_pattern: Sliders,
  placeholder:  CircleDashed,
}

const STATUS_COLOR: Record<string, string> = {
  active:      '#10B981',
  waiting:     '#F59E0B',
  error:       '#EF4444',
  idle:        '#8E8E9F',
  placeholder: '#555566',
}

export default function SourceNode({ data }: NodeProps) {
  const src = data as unknown as Source & { onDelete: (id: string) => void }
  const Icon = TYPE_ICON[src.source_type] ?? Radio
  const color = STATUS_COLOR[src.status] ?? '#8E8E9F'
  const isPlaceholder = src.source_type === 'placeholder'

  return (
    <div style={{
      background: '#1E1E2A',
      border: `2px solid ${isPlaceholder ? '#282838' : color}`,
      borderStyle: isPlaceholder ? 'dashed' : 'solid',
      borderRadius: 10,
      padding: '12px 16px',
      minWidth: 200,
      position: 'relative',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <Icon size={16} color={color} />
        <span style={{ fontWeight: 600, fontSize: 14, color: '#EEEEF2' }}>{src.name}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
        <span style={{ fontSize: 11, color: '#8E8E9F', textTransform: 'uppercase' }}>
          {src.source_type.replace('_', ' ')} · {src.status}
        </span>
      </div>
      {/* Output handle — right side */}
      <Handle type="source" position={Position.Right} style={{ background: color, width: 12, height: 12 }} />
    </div>
  )
}
