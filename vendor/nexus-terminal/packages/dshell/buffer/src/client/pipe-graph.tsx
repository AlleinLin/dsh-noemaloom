/**
 * The pipe graph: sessions as nodes, established pipes as edges, drawn with
 * React Flow (@xyflow/react) so the graph is a real working surface — nodes
 * drag, dragging from one node's handle to another creates the pipe for real
 * (through the same authority-checked service the list view uses), and a
 * selected edge offers detail and release.
 *
 * The graph is an undirected picture of the data: React Flow edges carry a
 * source and a target internally, but no arrowheads are drawn and creation
 * works from either end, so the rendering reads as the symmetric relation the
 * links are.
 */

import {
  Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow,
  type Edge, type Node, type NodeChange, type NodeProps,
} from '@xyflow/react'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { BufferLink, BufferTicket } from '../protocol.js'
import type {} from './locales.js'
import { FLOW_CSS } from './flow-css.js'

/** One session node's data as the graph renders it. */
export interface GraphSession {
  readonly id: string
  readonly label: string
  readonly sub: string | undefined
  /** Whether the session currently has a running turn. */
  readonly active: boolean
  /** Whether the session hosts this browser's current view. */
  readonly current: boolean
}

/** The graph's props: derived data plus the three actions a real surface needs. */
export interface PipeGraphProps {
  readonly t: TranslateNS<'dshellBuffer'>
  readonly sessions: readonly GraphSession[]
  readonly links: readonly BufferLink[]
  readonly tickets: readonly BufferTicket[]
  /** Create a pipe for real; the caller owns validation feedback. */
  readonly onConnect: (a: string, b: string) => void
  /** Release one pipe for real. */
  readonly onUnlink: (linkId: string) => void
  /** Open a pipe's ticket detail (in the list pane). */
  readonly onOpenDetail: (linkId: string) => void
}

const nodeStyle: CSSProperties = {
  minWidth: 150,
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 12,
  padding: '7px 10px',
  boxShadow: '0 2px 10px rgba(0,0,0,.25)',
}
const nodeActiveStyle: CSSProperties = {
  ...nodeStyle,
  borderColor: 'var(--dsw-static-deepseek-500, #4f6bed)',
}
const nodeTitleStyle: CSSProperties = {
  fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
const nodeSubStyle: CSSProperties = {
  fontSize: 11, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
const handleStyle: CSSProperties = {
  width: 9, height: 9, background: 'var(--dsw-alias-label-tertiary)',
  border: 'none',
}

/** One session node: title, optional cwd line, an active dot, two handles. */
function SessionNode(props: NodeProps): ReactElement {
  const data = props.data as {
    label: string; sub: string | undefined; active: boolean; current: boolean
    t: TranslateNS<'dshellBuffer'>
  }
  return (
    <div style={data.active ? nodeActiveStyle : nodeStyle}>
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {data.current
          ? <span title={data.t('graph.current')} style={{
            width: 7, height: 7, borderRadius: 999, flex: '0 0 auto',
            background: 'var(--dsw-static-deepseek-500, #4f6bed)',
          }} />
          : null}
        <span style={nodeTitleStyle}>{data.label}</span>
      </div>
      {data.sub === undefined ? null : <div style={nodeSubStyle}>{data.sub}</div>}
      <Handle type="source" position={Position.Bottom} style={handleStyle} />
    </div>
  )
}

const nodeTypes = { session: SessionNode }

/** localStorage key for the user's node arrangement. */
const POSITIONS_KEY = 'dshell-pipe-graph-positions-v2'

type NodePositions = Record<string, { x: number; y: number }>

/**
 * The arrangement the user dragged nodes into, kept across dialog opens.
 *
 * localStorage is the right home rather than the host state document: this is
 * one browser's view preference, not shared feature state, and the graph must
 * still render when the store is unavailable. The key carries its version
 * because the default arrangement changed from a ring to a grid: a remembered
 * ring coordinate would otherwise scatter the first grid-laid graph.
 */
function loadPositions(): NodePositions {
  try {
    const raw = localStorage.getItem(POSITIONS_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const out: NodePositions = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        typeof value === 'object' && value !== null
        && typeof (value as { x?: unknown }).x === 'number'
        && typeof (value as { y?: unknown }).y === 'number'
      ) {
        const { x, y } = value as { x: number; y: number }
        out[id] = { x, y }
      }
    }
    return out
  } catch {
    return {}
  }
}

function savePositions(positions: NodePositions): void {
  try {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions))
  } catch { /* a store that refuses writes just means no memory */ }
}

/** One cell of the default arrangement: wide enough for a title, tall enough for two lines. */
const CELL_WIDTH = 210
const CELL_HEIGHT = 112

/**
 * Where an undragged node sits: a centered grid, the way a session list reads.
 *
 * A ring whose radius grows with the session count was the first attempt and
 * the reason this pane could open as a plain void — a few dozen sessions put
 * every node outside the pane, and the fit was clamped before it could reach
 * them. A grid stays inside the pane at any count, and reads as rows rather
 * than as an arbitrary circle.
 *
 * @param index - the node's position in the snapshot's order.
 * @param count - how many nodes there are.
 * @returns centered coordinates, in React Flow's own units.
 */
function gridPosition(index: number, count: number): { x: number; y: number } {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)))
  const rows = Math.ceil(count / columns)
  const column = index % columns
  const row = Math.floor(index / columns)
  return {
    x: Math.round((column - (columns - 1) / 2) * CELL_WIDTH),
    y: Math.round((row - (rows - 1) / 2) * CELL_HEIGHT),
  }
}

/** Count a link's unsettled tickets, for the animated-edge signal. */
function openCount(tickets: readonly BufferTicket[], linkId: string): number {
  return tickets.filter(ticket => ticket.linkId === linkId
    && (ticket.state === 'queued' || ticket.state === 'running')).length
}

/** The graph pane. Wrap with {@link PipeGraphProvider} at the call site. */
function PipeGraphInner(props: PipeGraphProps): ReactElement {
  const t = props.t
  const flow = useReactFlow()
  const [positions, setPositions] = useState<NodePositions>(loadPositions)
  // Mirror for the drag-stop handler, which needs the live map to persist the
  // merged arrangement without reading state inside a state updater.
  const positionsRef = useRef(positions)
  positionsRef.current = positions
  // The selected edge: clicking one highlights it and floats the action chip.
  const [selected, setSelected] = useState<string | undefined>(undefined)
  // Inject React Flow's stylesheet once: the bundle loader mounts only this
  // package's client.js, so a sibling css file would never reach the page.
  useEffect(() => {
    if (document.querySelector('style[data-dshell-flow-css]') !== null) return
    const style = document.createElement('style')
    style.setAttribute('data-dshell-flow-css', '')
    style.textContent = FLOW_CSS
    document.head.append(style)
  }, [])

  // A new node set gets a fresh fit: the pane opens on the handful of related
  // sessions, and the same pane can be asked for every session in dsh — the
  // fit React Flow does on mount would leave that second set outside the view.
  // The reset button raises the same signal after it drops the arrangement.
  const [fitToken, setFitToken] = useState(0)
  const nodeKey = props.sessions.map(session => session.id).join('|')
  useEffect(() => { void flow.fitView({ padding: 0.28, duration: 200 }) }, [nodeKey, fitToken, flow])

  // Default arrangement for sessions the user has not dragged yet: a centered
  // grid, so every node opens inside the pane (see gridPosition).
  const nodes = useMemo<Node[]>(() => props.sessions.map((session, index) => {
    const fallback = gridPosition(index, props.sessions.length)
    return {
      id: session.id,
      type: 'session',
      position: positions[session.id] ?? fallback,
      data: { label: session.label, sub: session.sub, active: session.active, current: session.current, t },
    }
  }), [props.sessions, positions, t])

  const edges = useMemo<Edge[]>(() => props.links.map(link => {
    const open = openCount(props.tickets, link.id)
    return {
      id: link.id,
      source: link.a,
      target: link.b,
      type: 'straight',
      selected: selected === link.id,
      label: `${link.label ?? t('graph.pipe')}${open > 0 ? ` · ${t('graph.openUnits', { count: open })}` : ''}`,
      animated: open > 0,
      // A label sits under the nodes, so it needs room around it to read when a
      // node's edge lands on top of it.
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 4,
      style: {
        stroke: selected === link.id
          ? 'var(--dsw-static-deepseek-300, #7d9bff)'
          : open > 0 ? 'var(--dsw-static-deepseek-500, #4f6bed)' : 'var(--dsw-alias-border-l3)',
        strokeWidth: selected === link.id || open > 0 ? 2 : 1.2,
      },
      labelStyle: { fill: 'var(--dsw-alias-label-secondary)', fontSize: 11 },
      labelBgStyle: { fill: 'var(--dsw-alias-bg-layer-2)' },
    }
  }), [props.links, props.tickets, selected, t])

  const onNodesChange = (changes: NodeChange[]): void => {
    // Only drags matter here: the node set is derived from the snapshot, so a
    // removed/added node recomposes on the next render anyway. Positions are
    // the one piece of local state — the user's arrangement outlives polls,
    // and the drop event (below) also writes it to localStorage.
    setPositions(current => {
      let changed = false
      const next = { ...current }
      for (const change of changes) {
        if (change.type === 'position' && change.position !== undefined) {
          next[change.id] = change.position
          changed = true
        }
      }
      return changed ? next : current
    })
  }

  /** A drop ends the drag: persist the arrangement, pruned to current sessions. */
  const onNodeDragStop = (_event: unknown, node: Node): void => {
    const keep = new Set(props.sessions.map(session => session.id))
    const next: NodePositions = {}
    for (const [id, position] of Object.entries(positionsRef.current)) {
      if (keep.has(id)) next[id] = position
    }
    next[node.id] = node.position
    positionsRef.current = next
    savePositions(next)
  }

  return (
    <div style={paneStyle}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.28 }}
        minZoom={0.2}
        maxZoom={1.8}
        nodesConnectable
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={(connection) => {
          if (connection.source === undefined || connection.target === undefined) return
          if (connection.source === connection.target) return
          props.onConnect(connection.source, connection.target)
        }}
        onEdgeClick={(_, edge) => { setSelected(current => (current === edge.id ? undefined : edge.id)) }}
        onPaneClick={() => { setSelected(undefined) }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color='var(--dsw-alias-border-l3)' gap={22} />
        <Controls showInteractive={false} />
      </ReactFlow>
      <div style={hintStyle}>{t('graph.hint')}</div>
      {props.sessions.length === 0 ? <div style={emptyStyle}>{t('graph.empty')}</div> : null}
      {selected === undefined ? null : (
        <div style={chipStyle}>
          <span style={chipDimStyle}>{t('graph.selected')}</span>
          <button style={chipButtonStyle} onClick={() => { props.onOpenDetail(selected) }}>{t('action.detail')}</button>
          <button
            style={chipButtonStyle}
            onClick={() => { props.onUnlink(selected); setSelected(undefined) }}
          >{t('action.release')}</button>
          <button style={chipButtonStyle} onClick={() => { setSelected(undefined) }}>✕</button>
        </div>
      )}
      <div style={resetStyle}>
        <button
          style={chipButtonStyle}
          title={t('graph.resetTitle')}
          onClick={() => {
            try { localStorage.removeItem(POSITIONS_KEY) } catch { /* same as empty */ }
            setPositions({})
            setFitToken(token => token + 1)
          }}
        >{t('action.resetLayout')}</button>
      </div>
    </div>
  )
}

/**
 * The pane itself. The canvas colour is published as React Flow's own variable
 * rather than through `colorMode`: that prop pins the surface to one scheme and
 * a dialog that follows the app's theme must not open a black rectangle in a
 * light one. The node and edge colours are dsh tokens either way.
 *
 * The zoom controls need the same treatment for the same reason: their shipped
 * defaults are a light grey button on white, which is a white block in the
 * middle of a dark canvas (the `colorMode` prop would have covered it, at the
 * cost of the canvas following the app instead of the other way round).
 */
const paneStyle = {
  position: 'absolute', inset: 0,
  '--xy-background-color': 'var(--dsw-alias-bg-layer-1)',
  '--xy-controls-button-background-color': 'var(--dsw-alias-bg-layer-2)',
  '--xy-controls-button-background-color-hover': 'var(--dsw-alias-interactive-bg-hover)',
  '--xy-controls-button-color': 'var(--dsw-alias-label-primary)',
  '--xy-controls-button-color-hover': 'var(--dsw-alias-label-primary)',
  '--xy-controls-button-border-color': 'var(--dsw-alias-border-l4)',
  '--xy-controls-box-shadow': '0 2px 10px rgba(0,0,0,.25)',
} as CSSProperties

/** The wiring hint, quiet enough to read as a caption. */
const hintStyle: CSSProperties = {
  position: 'absolute', top: 10, left: 12, zIndex: 5,
  fontSize: 11, opacity: 0.55, pointerEvents: 'none',
  color: 'var(--dsw-alias-label-secondary)',
}

const chipStyle: CSSProperties = {
  position: 'absolute', top: 10, right: 10, zIndex: 5,
  display: 'flex', alignItems: 'center', gap: 6,
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-2)',
  padding: '5px 8px', fontSize: 12,
  color: 'var(--dsw-alias-label-primary)',
  boxShadow: '0 4px 14px rgba(0,0,0,.3)',
}
const chipDimStyle: CSSProperties = { opacity: 0.6, marginRight: 2 }
const chipButtonStyle: CSSProperties = {
  border: '0.5px solid var(--dsw-alias-border-l4)', background: 'transparent', color: 'inherit',
  cursor: 'pointer', fontSize: 12, padding: '2px 8px', borderRadius: 6,
}
const resetStyle: CSSProperties = {
  position: 'absolute', bottom: 10, right: 10, zIndex: 5,
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-2)',
  padding: '3px 6px',
  boxShadow: '0 4px 14px rgba(0,0,0,.3)',
}
/** The note a graph with no nodes shows, where a session list would be empty. */
const emptyStyle: CSSProperties = {
  position: 'absolute', inset: 0, zIndex: 4,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 12, opacity: 0.6, pointerEvents: 'none',
}

/** The graph pane with the provider React Flow needs for measured layout. */
export function PipeGraph(props: PipeGraphProps): ReactElement {
  return <ReactFlowProvider><PipeGraphInner {...props} /></ReactFlowProvider>
}
