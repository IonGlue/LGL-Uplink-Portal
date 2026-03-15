import { useCallback, useEffect, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Edge,
  type Node,
  BackgroundVariant,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { api, type Source, type Destination, type Route } from '../api.js'
import SourceNode from './SourceNode.js'
import DestNode from './DestNode.js'
import RoutingEdge from './RoutingEdge.js'
import AddSourcePanel from './AddSourcePanel.js'
import AddDestPanel from './AddDestPanel.js'

const NODE_TYPES = { source: SourceNode, dest: DestNode }
const EDGE_TYPES = { routing: RoutingEdge }

function sourceToNode(src: Source): Node {
  return {
    id: `src-${src.id}`,
    type: 'source',
    position: { x: src.position_x, y: src.position_y },
    data: { ...src },
    dragHandle: '.react-flow__node',
  }
}

function destToNode(dest: Destination): Node {
  return {
    id: `dst-${dest.id}`,
    type: 'dest',
    position: { x: dest.position_x, y: dest.position_y },
    data: { ...dest },
    dragHandle: '.react-flow__node',
  }
}

function routeToEdge(route: Route, onDelete: (routeId: string) => void): Edge {
  return {
    id: route.id,
    source: `src-${route.source_id}`,
    target: `dst-${route.dest_id}`,
    type: 'routing',
    data: { onDelete, source_status: route.source_status },
  }
}

export default function Patchbay() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [showAddSource, setShowAddSource] = useState(false)
  const [showAddDest, setShowAddDest] = useState(false)
  const [loading, setLoading] = useState(true)

  const handleDeleteRoute = useCallback(async (routeId: string) => {
    try {
      await api.deleteRoute(routeId)
      setEdges(eds => eds.filter(e => e.id !== routeId))
      setRoutes(rs => rs.filter(r => r.id !== routeId))
    } catch (e) {
      console.error('failed to delete route:', e)
    }
  }, [setEdges])

  useEffect(() => {
    async function load() {
      try {
        const [sources, dests, routes] = await Promise.all([
          api.getSources(),
          api.getDests(),
          api.getRoutes(),
        ])
        setNodes([
          ...sources.map(sourceToNode),
          ...dests.map(destToNode),
        ])
        setEdges(routes.map(r => routeToEdge(r, handleDeleteRoute)))
        setRoutes(routes)
      } catch (e) {
        console.error('failed to load patchbay:', e)
      } finally {
        setLoading(false)
      }
    }
    load()
    // Refresh every 5s for live status updates
    const interval = setInterval(load, 5000)
    return () => clearInterval(interval)
  }, [setNodes, setEdges, handleDeleteRoute])

  const onConnect = useCallback(async (connection: Connection) => {
    const sourceId = connection.source?.replace('src-', '')
    const destId = connection.target?.replace('dst-', '')
    if (!sourceId || !destId) return
    // Only allow source → dest connections
    if (!connection.source?.startsWith('src-') || !connection.target?.startsWith('dst-')) return

    try {
      const route = await api.createRoute(sourceId, destId)
      const edge = routeToEdge(route, handleDeleteRoute)
      setEdges(eds => addEdge(edge, eds))
      setRoutes(rs => [...rs, route])
    } catch (e) {
      console.error('failed to create route:', e)
    }
  }, [setEdges, handleDeleteRoute])

  const onNodeDragStop = useCallback(async (_event: React.MouseEvent, node: Node) => {
    const { x, y } = node.position
    const isSource = node.id.startsWith('src-')
    const id = node.id.replace(/^(src|dst)-/, '')
    try {
      if (isSource) {
        await api.updateSource(id, { position_x: x, position_y: y })
      } else {
        await api.updateDest(id, { position_x: x, position_y: y })
      }
    } catch { /* non-fatal */ }
  }, [])

  const handleSourceAdded = useCallback((src: Source) => {
    setNodes(ns => [...ns, sourceToNode(src)])
  }, [setNodes])

  const handleDestAdded = useCallback((dest: Destination) => {
    setNodes(ns => [...ns, destToNode(dest)])
  }, [setNodes])

  if (loading) return <div style={{ padding: '2rem', color: '#94a3b8' }}>Loading patchbay...</div>

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#0f1117' }}>
      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px', borderBottom: '1px solid #2d3348', background: '#1e2130' }}>
        <span style={{ fontWeight: 700, fontSize: 16, color: '#e2e8f0', marginRight: 'auto' }}>
          LGL Ingest — Patchbay
        </span>
        <button
          onClick={() => setShowAddSource(true)}
          style={{ background: '#1d4ed8', border: 'none', borderRadius: 6, padding: '7px 14px', color: '#fff', fontSize: 13, cursor: 'pointer' }}
        >
          + Source
        </button>
        <button
          onClick={() => setShowAddDest(true)}
          style={{ background: '#047857', border: 'none', borderRadius: 6, padding: '7px 14px', color: '#fff', fontSize: 13, cursor: 'pointer' }}
        >
          + Destination
        </button>
        <span style={{ fontSize: 12, color: '#64748b' }}>
          {nodes.filter(n => n.id.startsWith('src-')).length} sources · {nodes.filter(n => n.id.startsWith('dst-')).length} destinations · {edges.length} routes
        </span>
      </div>

      {/* Canvas */}
      <div style={{ flex: 1 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStop={onNodeDragStop}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          fitView
          proOptions={{ hideAttribution: true }}
          style={{ background: '#0f1117' }}
        >
          <Background color="#1e2130" variant={BackgroundVariant.Dots} />
          <Controls style={{ background: '#1e2130', border: '1px solid #2d3348' }} />
        </ReactFlow>
      </div>

      {showAddSource && (
        <AddSourcePanel onClose={() => setShowAddSource(false)} onAdded={handleSourceAdded} />
      )}
      {showAddDest && (
        <AddDestPanel onClose={() => setShowAddDest(false)} onAdded={handleDestAdded} />
      )}
    </div>
  )
}
