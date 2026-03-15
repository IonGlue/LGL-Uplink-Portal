import { BaseEdge, EdgeLabelRenderer, getStraightPath, type EdgeProps } from '@xyflow/react'

export default function RoutingEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getStraightPath({ sourceX, sourceY, targetX, targetY })
  const routeData = data as { onDelete?: (id: string) => void; source_status?: string } | undefined
  const isActive = routeData?.source_status === 'active'

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{ stroke: isActive ? '#22c55e' : '#64748b', strokeWidth: 2, strokeDasharray: isActive ? '0' : '6 3' }}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
          }}
        >
          <button
            onClick={() => routeData?.onDelete?.(id)}
            style={{
              background: '#1e2130',
              border: '1px solid #2d3348',
              borderRadius: '50%',
              width: 20,
              height: 20,
              cursor: 'pointer',
              fontSize: 11,
              color: '#94a3b8',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            title="Remove route"
          >
            ×
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  )
}
