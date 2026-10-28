"use client";
import "@xyflow/react/dist/style.css";

import { useCallback, useEffect, useRef, useState } from "react";
import { BaseEdge, Controls, EdgeLabelRenderer, type Edge, type EdgeProps, Handle, MarkerType, type Node, type NodeProps, type OnSelectionChangeFunc, Position, ReactFlow, ReactFlowProvider, getBezierPath, useEdgesState, useNodesInitialized, useNodesState, useReactFlow } from "@xyflow/react";
import { ArrowDownToLine, Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { INLINE_INPUT, accent } from "@/components/org/parts";
import { fmt } from "@/components/page";
import { windowSummary } from "@/components/process/step-chain";
import { deptHeadcount } from "@/components/org/ops";
import { autoLayout, fillLayout } from "@/components/process/layout";
import { type Issue, addInflow, addStep, connect, disconnect, inflowsOf, nextFreePos, reachable, removeNode, renameInflow, renameStep, stepIssues, toInflows } from "@/components/process/graph";
import { type Company, type Inflow, type Pos, type Step, type Workflow, durationMean, idFor } from "@/lib/company";
import { DetailPanel } from "@/components/process/panel";
import { useConfirm } from "@/lib/confirm";

type Named = { focus: boolean; onRename: (name: string) => void; onFocusDone: () => void };
type StepData = Named & { st: Step; color: string | null; deptName: string; issues: Issue[]; fanIn: number; fanOut: number };
type InflowData = Named & { inflow: Inflow };

/** Uncontrolled name committed on blur or Enter; an emptied box snaps back. A new node's box starts focused and selected. */
function NameInput({ name, label, focus, onRename, onFocusDone }: Named & { name: string; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const measured = useNodesInitialized();
  useEffect(() => { if (focus && measured) ref.current?.focus(); }, [focus, measured]); // autoFocus misses: React Flow hides a node until it is measured
  return <Input ref={ref} key={name} aria-label={label} defaultValue={name} className={`nodrag nopan h-7 font-medium ${INLINE_INPUT}`}
    onFocus={focus ? (e) => e.currentTarget.select() : undefined}
    onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
    onBlur={(e) => {
      if (focus) onFocusDone();
      const v = e.currentTarget.value.trim();
      if (!v) e.currentTarget.value = name;
      else if (v !== name) onRename(v);
    }} />;
}

const TAG = "pointer-events-none absolute -top-4 whitespace-nowrap text-[10px] text-muted-foreground";

function StepNode({ data }: NodeProps<Node<StepData, "step">>) {
  const { st, color, deptName, issues, fanIn, fanOut } = data;
  return (
    <div className="relative flex w-52 flex-col gap-0.5 rounded-xl py-2 pr-2 pl-3.5 glass-inset">
      <span aria-hidden className={`absolute inset-y-2 left-1 rounded-full ${color ? "w-[3px]" : "border-l-[3px] border-dashed border-muted-foreground/50"}`} style={color ? { background: color } : undefined} />
      <div className="flex items-center gap-1.5">
        <NameInput name={st.name} label={`name of step ${st.id}`} {...data} />
        {issues.length > 0 && <span title={issues.map((i) => i.text).join("\n")} className="size-2 shrink-0 rounded-full bg-amber-400 shadow-[0_0_8px_#fbbf24]" />}
      </div>
      <div className="flex items-center gap-1.5 px-1.5 text-xs text-muted-foreground">
        <span className="truncate">{`${deptName || "no department"} · ${fmt(durationMean(st.duration))} min`}</span>
        {st.system_id && <span className="shrink-0 rounded-full px-1.5 font-mono text-[10px] glass-inset">{st.system_id}</span>}
      </div>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      {fanIn >= 2 && <span className={`${TAG} left-0`}>waits for all</span>}
      {fanOut >= 2 && <span className={`${TAG} right-0`}>all run</span>}
    </div>
  );
}

function InflowNode({ data }: NodeProps<Node<InflowData, "inflow">>) {
  const { inflow } = data;
  return (
    <div className="flex w-52 items-center gap-2 rounded-full py-1.5 pr-4 pl-3 glass-inset">
      <ArrowDownToLine className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-col">
        <NameInput name={inflow.name} label={`name of inflow ${inflow.id}`} {...data} />
        <span className="truncate px-1.5 text-xs text-muted-foreground">{`${fmt(inflow.rate_per_hour, 2)}/h · ${windowSummary(inflow.window)}`}</span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { step: StepNode, inflow: InflowNode };
const edgeTypes = { flow: FlowEdge };
const DEPT = "application/x-flock-dept";
const INFLOW = "application/x-flock-inflow";
const CHIP = "press flex cursor-grab items-center gap-2 rounded-xl px-3 py-2 text-left text-sm glass-inset";

/** Bezier arrow with a remove button at its midpoint while hovered or selected. */
function FlowEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, selected, data }: EdgeProps<Edge<{ onRemove: () => void }>>) {
  const [hover, setHover] = useState(false);
  const [path, x, y] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return (
    <>
      <g onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}><BaseEdge path={path} markerEnd={markerEnd} /></g>
      <EdgeLabelRenderer>
        <button type="button" aria-label="remove arrow" onClick={data?.onRemove}
          className={`nodrag nopan pointer-events-auto absolute flex size-4 items-center justify-center rounded-full bg-muted text-muted-foreground transition-opacity hover:text-foreground hover:opacity-100 focus-visible:opacity-100 ${selected || hover ? "opacity-100" : "opacity-0"}`}
          style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}><X className="size-3" /></button>
      </EdgeLabelRenderer>
    </>
  );
}

/** Drag-and-drop process editor: boxes are steps, arrows are "after", inflow pills are the entry channels. */
export function ProcessCanvas(props: { wf: Workflow; company: Company; onChange: (w: Workflow) => void }) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}

function Canvas({ wf, company, onChange }: { wf: Workflow; company: Company; onChange: (w: Workflow) => void }) {
  const confirm = useConfirm();
  const { screenToFlowPosition, fitView } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const edit = (f: (w: Workflow) => Workflow) => onChange(f(wf.inflows ? wf : { ...toInflows(wf), layout: fillLayout(wf) }));
  const stepName = (id: string) => wf.steps.find((s) => s.id === id)?.name ?? id;

  useEffect(() => {
    const pos = fillLayout(wf);
    const inflows = inflowsOf(wf);
    const reach = reachable(wf);
    const ids = [...wf.steps.map((s) => s.id), ...inflows.map((i) => i.id)];
    const at = (id: string) => ({ x: pos[id][0], y: pos[id][1] });
    const named = (id: string, rename: (w: Workflow, to: string, name: string) => Workflow, base: string) => ({
      focus: focusId === id,
      onFocusDone: () => setFocusId(null),
      onRename: (name: string) => {
        const to = idFor(name, ids.filter((x) => x !== id), base, id);
        onChange(rename(toInflows(wf), to, name));
        setSelected((s) => (s === id ? to : s));
      },
    });
    setNodes((prev) => [
      ...inflows.map((inflow) => ({ id: inflow.id, type: "inflow", position: at(inflow.id), selected: selected === inflow.id,
        data: { inflow, ...named(inflow.id, (w, to, name) => renameInflow({ ...w, inflows: w.inflows!.map((i) => (i.id === inflow.id ? { ...i, name } : i)) }, inflow.id, to), "inflow") } })),
      ...wf.steps.map((st) => {
        const di = company.departments.findIndex((d) => d.id === st.department_id);
        return { id: st.id, type: "step", position: at(st.id), selected: selected === st.id, data: {
          st, color: di < 0 ? null : accent(di), deptName: company.departments[di]?.name ?? "", issues: stepIssues(company, wf, st, reach),
          fanIn: (st.depends_on?.length ?? 0) + inflows.filter((i) => i.entry.includes(st.id)).length,
          fanOut: wf.steps.filter((s) => s.depends_on?.includes(st.id)).length,
          ...named(st.id, (w, to, name) => renameStep({ ...w, steps: w.steps.map((s) => (s.id === st.id ? { ...s, name } : s)) }, st.id, to), "step") } };
      }),
    ].map((n) => ({ ...n, measured: prev.find((p) => p.id === n.id)?.measured }))); // kept sizes spare every node a hidden re-measure
    const edge = (from: string, to: string) => ({ id: `${from}->${to}`, source: from, target: to, type: "flow", deletable: true, markerEnd: { type: MarkerType.ArrowClosed },
      data: { onRemove: () => onChange(disconnect(toInflows(wf), from, to)) } });
    setEdges((prev) => [...inflows.flatMap((i) => i.entry.map((e) => edge(i.id, e))), ...wf.steps.flatMap((s) => (s.depends_on ?? []).map((d) => edge(d, s.id)))]
      .map((e) => ({ ...e, selected: prev.find((p) => p.id === e.id)?.selected }))); // a selected edge stays deletable across re-syncs
  }, [wf, company, selected, focusId, onChange, setNodes, setEdges]);

  const panelOpen = selected !== null;
  useEffect(() => { // the panel takes a grid column: refit so nodes on the right do not end up under it
    const t = setTimeout(() => fitView({ duration: 200 }));
    return () => clearTimeout(t);
  }, [panelOpen, fitView]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) setSelected(null); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);

  const onSelectionChange = useCallback<OnSelectionChangeFunc>(({ nodes }) => setSelected(nodes[0]?.id ?? null), []);

  const removeSelected = async () => {
    if (!selected) return;
    const inflow = inflowsOf(wf).some((i) => i.id === selected);
    if (!(await confirm("Its arrows are removed with it.", { title: inflow ? "Remove this inflow?" : "Remove this step?", action: "Remove", destructive: true }))) return;
    edit((w) => removeNode(w, selected));
    setSelected(null);
  };

  const add = (kind: "step" | "inflow", deptId: string, pos: Pos) => {
    const w = toInflows(wf);
    const r = kind === "inflow" ? addInflow(w, pos) : addStep(w, company.departments.find((d) => d.id === deptId) ?? null, pos);
    onChange(r.wf);
    setFocusId(r.id);
    setSelected(r.id);
  };
  const clickAdd = (kind: "step" | "inflow", deptId = "") => add(kind, deptId, nextFreePos({ ...wf, layout: fillLayout(wf) }));
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const dept = e.dataTransfer.getData(DEPT), inflow = e.dataTransfer.types.includes(INFLOW);
    if (!inflow && !e.dataTransfer.types.includes(DEPT)) return;
    const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    add(inflow ? "inflow" : "step", dept, [Math.round(p.x), Math.round(p.y)]);
  };
  const chip = (type: string, value: string) => ({ draggable: true, onDragStart: (e: React.DragEvent) => e.dataTransfer.setData(type, value) });

  return (
    <div className={`grid min-h-0 flex-1 gap-4 ${selected ? "lg:grid-cols-[11rem_1fr_18rem]" : "lg:grid-cols-[11rem_1fr]"}`}>
      <div className="flex flex-wrap gap-2 lg:w-44 lg:flex-col">
        {company.departments.map((d, i) => (
          <button key={d.id} type="button" className={CHIP} {...chip(DEPT, d.id)} onClick={() => clickAdd("step", d.id)}>
            <span className="size-2 shrink-0 rounded-full" style={{ background: accent(i) }} />
            <span className="flex-1 truncate">{d.name}</span>
            <span className="text-xs tabular-nums text-muted-foreground">{deptHeadcount(company, d)}</span>
          </button>
        ))}
        <button type="button" className={CHIP} {...chip(DEPT, "")} onClick={() => clickAdd("step")}><Plus className="size-3.5" /> Step</button>
        <button type="button" className={CHIP} {...chip(INFLOW, "")} onClick={() => clickAdd("inflow")}><ArrowDownToLine className="size-3.5" /> Inflow</button>
        <button type="button" className="press rounded-full border border-border px-3 py-1.5 text-sm hover:bg-muted"
          onClick={() => { edit((w) => ({ ...w, layout: autoLayout(w) })); setTimeout(() => fitView({ duration: 300 })); }}>Auto layout</button>
        <p className="hidden text-xs text-muted-foreground lg:block">Several arrows into a step mean it waits for all of them; several arrows out mean all of them run. An either/or split is modelled as two inflows.</p>
      </div>
      <div className="flex min-h-0 flex-col gap-2">
        <div className="glass min-h-[32rem] flex-1 overflow-hidden rounded-2xl lg:min-h-0" onDrop={onDrop} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}>
          <ReactFlow colorMode="dark" fitView minZoom={0.3} maxZoom={1.5} nodesConnectable nodeTypes={nodeTypes} edgeTypes={edgeTypes}
            nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onSelectionChange={onSelectionChange}
            onNodeDragStop={(_, n) => edit((w) => ({ ...w, layout: { ...w.layout, [n.id]: [Math.round(n.position.x), Math.round(n.position.y)] } }))}
            onConnect={({ source, target }) => {
              const w = toInflows(wf);
              const next = connect(w, source, target);
              if (next === null) setToast(`That would loop back to ${stepName(target)}`);
              else if (next !== w) onChange(next);
            }}
            deleteKeyCode={["Delete", "Backspace"]} multiSelectionKeyCode={null} selectionKeyCode={null}
            onBeforeDelete={async ({ nodes }) => nodes.length === 0 || confirm("Its arrows are removed with it.", { title: nodes[0].type === "inflow" ? "Remove this inflow?" : "Remove this step?", action: "Remove", destructive: true })}
            onDelete={({ nodes, edges }) => edit((w) => {
              let n = w;
              for (const e of edges) n = disconnect(n, e.source, e.target);
              for (const x of nodes) n = removeNode(n, x.id);
              return n;
            })}>
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        {toast && <p className="text-xs text-amber-400">{toast}</p>}
      </div>
      {selected && <DetailPanel wf={toInflows(wf)} company={company} selected={selected} onChange={onChange} onClose={() => setSelected(null)} onRenamed={setSelected} onRemove={removeSelected} />}
    </div>
  );
}
