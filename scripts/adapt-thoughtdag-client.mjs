import { createHash } from 'node:crypto';
import ts from 'typescript';

// Published dsh-thoughtdag@0.5.21. The names below are local to this reviewed
// Vite asset; fail closed when upstream changes instead of guessing at code.
export const THOUGHTDAG_SOURCE_ASSET = 'assets/index-DDS2ZyPK.js';
export const THOUGHTDAG_CLIENT_ASSET = 'assets/nexus-entry.js';
const REVIEWED_CLIENT_SHA256 = '227907218eeb1fa4ca08feaec7652d841b482f6e7457e72e9a8916f4b4797b54';
const REVIEWED_HTML_SHA256 = 'dc4f321465428fe8d1e5703ba60a2a1719023ea1aaf17f7f63ca381f00f4538f';
const EMBEDDED_FRESH_ROUTE = 'if(__nexusThoughtdagEmbedded)return d;';
const SUPPRESSED_PLUGIN_UPDATE = 'async function g0e(e){}';
const ORIGINAL_FIT_MAX_ZOOM = 'o?.maxZoom??s';
const EMBEDDED_FIT_MAX_ZOOM = '(__nexusThoughtdagEmbedded?Math.min(1,o?.maxZoom??s):o?.maxZoom??s)';
const GENERATED_SESSION_NOTIFICATION = `;if(__nexusThoughtdagEmbedded&&m()&&typeof I==="string"&&I){
      window.parent.postMessage({
        source:"dsh-thoughtdag",type:"td:generated-session",sessionId:I
      },window.location.origin);
    }`;
const digest = source => createHash('sha256').update(source).digest('hex');
const one = (items, label) => {
  if (items.length !== 1) throw new Error(`ThoughtDAG client adapter: expected one ${label}, got ${items.length}`);
  return items[0];
};
const parse = source => {
  const ast = ts.createSourceFile('thoughtdag-original.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) throw new Error('ThoughtDAG client adapter: invalid original/adapted JavaScript');
  return ast;
};
function descendants(root, predicate) {
  const result = [];
  const visit = node => {
    if (predicate(node)) result.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return result;
}
function namedFunction(ast, name) {
  return one(ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name), `function ${name}`);
}
function property(object, name) {
  if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
  return object.properties.find(node => ts.isPropertyAssignment(node)
    && (ts.isStringLiteral(node.name) || ts.isIdentifier(node.name)) && node.name.text === name);
}
function componentCalls(root, name) {
  return descendants(root, node => ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.expression.getText() === 'l'
    && ['jsx', 'jsxs'].includes(node.expression.name.text)
    && ts.isIdentifier(node.arguments[0]) && node.arguments[0].text === name);
}

/**
 * Keep the original application and graph algorithms. Only the session-owned
 * shell seats, mirror admission, embedded harness routing and viewport sizing
 * are adapted.
 * This function is pure: callers write the returned asset to build output.
 */
export function adaptThoughtdagClient(original) {
  if (digest(original) !== REVIEWED_CLIENT_SHA256) {
    throw new Error('ThoughtDAG client adapter requires the reviewed 0.5.21 client SHA256');
  }
  const ast = parse(original);
  const canvas = namedFunction(ast, 'M0e');
  const switcher = namedFunction(ast, 'ade');
  const mirror = namedFunction(ast, 'qV');
  const outbound = namedFunction(ast, 'm7');
  const generation = namedFunction(ast, 'Hi');
  // Assert that the projected source still uses the original opener, parser,
  // canonical importer, watermark, and live bridge before changing admission.
  const opener = namedFunction(ast, 'xv').getText(ast);
  if (!opener.includes('await Iy(e)') || !mirror.getText(ast).includes('importOrAppendConversation')
    || !mirror.getText(ast).includes('focusOnRefresh:!1')
    || !mirror.getText(ast).includes('shellSessionReader')
    || !mirror.getText(ast).includes('thoughtdag.atlas.sweepmark')) {
    throw new Error('ThoughtDAG client adapter: original canonical live mirror contract changed');
  }
  const edits = [];
  const replace = (node, text) => edits.push({ start: node.getStart(ast), end: node.end, text });
  const sessionGuard = node => replace(node, `(!__nexusThoughtdagSessionId&&${node.getText(ast)})`);

  // These are component *calls*, not component implementations. In particular,
  // node editors, the FocusPanel and graph execution keep their original code.
  sessionGuard(one(componentCalls(canvas, 'ade'), 'canvas ProjectSwitcher call'));
  // CanvasChat is the original "ask this graph" insight tool, not the DSH main
  // composer. Preserve both it and its toolbar entry in conversation canvases.
  one(componentCalls(canvas, 'fue'), 'original graph insight tool');
  one(descendants(canvas, node => ts.isCallExpression(node)
    && property(node.arguments[1], 'data-chat-entry')), 'original graph insight entry');
  const landing = one(descendants(canvas, node => ts.isCallExpression(node)
    && property(node.arguments[1], 'className')?.initializer.getText(ast)
      === '"absolute inset-0 flex items-center justify-center pointer-events-none overflow-hidden"'),
  'empty-canvas standalone landing');
  if (!landing.getText(ast).includes('"data-landing-atlas"')) {
    throw new Error('ThoughtDAG client adapter: reviewed standalone landing changed');
  }
  sessionGuard(landing);
  // Global/workspace canvases retain the original compact project tool and its
  // graph library. Navigation back to DSH belongs to the outer native surface.
  const viewSwitch = one(componentCalls(switcher, 'ede'), 'HarnessViewSwitch call');
  replace(viewSwitch, `(!__nexusThoughtdagEmbedded&&${viewSwitch.getText(ast)})`);
  const canvasReturn = one(canvas.body.statements.filter(ts.isReturnStatement), 'canvas return');
  const viewportRef = one(descendants(canvas, node => ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name) && node.name.text === 'le'), 'original ReactFlow instance ref');
  if (viewportRef.initializer?.getText(ast) !== 'O.useRef(null)') {
    throw new Error('ThoughtDAG client adapter: original ReactFlow instance ref changed');
  }
  // Keep the original renderer/onInit and node data intact. The effect owns
  // only a bounded response to the outer frame's visibility/size notifications.
  edits.push({
    start: canvasReturn.getStart(ast), end: canvasReturn.getStart(ast),
    text: 'O.useEffect(()=>__nexusThoughtdagResizeView(()=>le.current),[]);',
  });
  // Mount, delayed project-switch and import fits all use this one upstream
  // fitView calculation. Cap its automatic fit without changing manual zoom,
  // setCenter, the renderer's maxZoom, or any node geometry.
  const fitBounds = one(descendants(namedFunction(ast, 'XP'), node => ts.isCallExpression(node)
    && ts.isIdentifier(node.expression) && node.expression.text === 'F2'), 'original fitView bounds calculation');
  if (fitBounds.arguments.length !== 6
    || fitBounds.arguments[4].getText(ast) !== ORIGINAL_FIT_MAX_ZOOM) {
    throw new Error('ThoughtDAG client adapter: original automatic fit maximum zoom changed');
  }
  replace(fitBounds.arguments[4], EMBEDDED_FIT_MAX_ZOOM);

  // A current-session message supplies identity only. Admit the exact scoped
  // session to the original serial mirror handler even before its first
  // subscription exists, or when its existing canvas is not active. The
  // original parser/canonical importer still performs every import and append.
  const existingSubscription = one(descendants(mirror, node => ts.isIfStatement(node)
    && node.expression.getText(ast) === 'b.some(W=>m(W).includes(w))'), 'mirror existing-subscription gate');
  replace(existingSubscription.expression, `(${existingSubscription.expression.getText(ast)}&&w!==__nexusThoughtdagSessionId)`);
  const provenance = one(descendants(mirror, node => ts.isIfStatement(node)
    && node.expression.getText(ast) === '!N.getState().nodes.some(W=>W.data.importSource?.sessionId===w)'),
  'mirror provenance gate');
  replace(provenance.expression, `(${provenance.expression.getText(ast)}&&w!==__nexusThoughtdagSessionId)`);
  const subscribe = one(mirror.body.statements.filter(node => ts.isExpressionStatement(node)
    && node.expression.getText(ast) === 'e.onSessionsChanged(d=>{a(d)})'), 'mirror change subscription');
  edits.push({
    start: subscribe.end, end: subscribe.end,
    text: `
if(__nexusThoughtdagSessionId){
  // Use the same serialized handler as the original seq-driven change feed.
  // An empty session stays eligible when its first real turn arrives later.
  Promise.resolve(EC()).then(()=>a({
    rootKey:Pc,rel:__nexusThoughtdagSessionId+Kx
  })).catch(error=>console.error("[nexus] ThoughtDAG session projection",error));
}
`,
  });

  // Upstream continuation/fork inherits the native session's history and omits
  // the graph-compiled messages. Embedded graph generation must instead use its
  // original fresh-create path, which compiles and injects the complete graph
  // context. Keep the selected harness model and cwd; the host owns provenance.
  const cwd = one(outbound.body.statements.filter(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name)
      && declaration.name.text === 'o')), 'harness cwd declaration');
  if (!cwd.getText(ast).includes('?.agentCwd??await XW()??Ym?.cwd??void 0')
    || !cwd.getText(ast).includes('...u==="auto"||u==="allow"?{permission:u}:{}')) {
    throw new Error('ThoughtDAG client adapter: original harness cwd selection changed');
  }
  edits.push({
    start: cwd.end, end: cwd.end,
    text: EMBEDDED_FRESH_ROUTE,
  });

  // A session-created event precedes the actual generation. Notify DSH only
  // after a non-empty successful response has passed the original turn stamp.
  const stamp = one(descendants(generation, node => ts.isExpressionStatement(node)
    && ts.isAwaitExpression(node.expression)
    && ts.isCallExpression(node.expression.expression)
    && ts.isIdentifier(node.expression.expression.expression)
    && node.expression.expression.expression.text === 'b7'), 'completed harness turn stamp');
  if (stamp.expression.getText(ast) !== 'await b7(e,t,n,{question:r,response:J},C,I,M,te)'
    || !ts.isBlock(stamp.parent) || !ts.isIfStatement(stamp.parent.parent)
    || stamp.parent.parent.expression.getText(ast) !== 'U(J),C') {
    throw new Error('ThoughtDAG client adapter: original harness completion contract changed');
  }
  edits.push({
    start: stamp.end, end: stamp.end,
    text: GENERATED_SESSION_NOTIFICATION,
  });
  // Nexus owns the installed package. The standalone updater tells people to
  // install a second plugin, so suppress its network probe and UI publication.
  // Keep release notes, ordinary error toasts and every other implementation.
  const updater = namedFunction(ast, 'g0e');
  if (!updater.getText(ast).includes('setPluginUpdate({current:n.version,latest:n.latest})')
    || !updater.getText(ast).includes('"/version"')
    || !updater.getText(ast).includes('plugin.updateHintDesktop')) {
    throw new Error('ThoughtDAG client adapter: original standalone updater changed');
  }
  replace(updater, SUPPRESSED_PLUGIN_UPDATE);

  // Coordinates, camera state, project persistence and all original tools
  // remain untouched. The parent bootstrap already supplies scoped storage
  // and API URLs; the fixed document identity is the source of this policy.
  const prelude = `
const __nexusThoughtdagQuery=new URLSearchParams(window.location.search);
const __nexusThoughtdagLevel=__nexusThoughtdagQuery.get("nexusLevel");
const __nexusThoughtdagId=__nexusThoughtdagQuery.get("nexusId");
const __nexusThoughtdagEmbedded=window.parent!==window&&!!__nexusThoughtdagId
  &&["global","workspace","session"].includes(__nexusThoughtdagLevel);
const __nexusThoughtdagSessionId=__nexusThoughtdagEmbedded
  &&__nexusThoughtdagLevel==="session"?__nexusThoughtdagId:null;
if(__nexusThoughtdagEmbedded){
  document.documentElement.dataset.nexusThoughtdagMode=__nexusThoughtdagLevel;
}
`;
  edits.sort((left, right) => right.start - left.start);
  for (let index = 1; index < edits.length; index++) {
    if (edits[index].end > edits[index - 1].start) {
      throw new Error('ThoughtDAG client adapter: overlapping original AST edits');
    }
  }
  let adapted = original;
  for (const edit of edits) adapted = adapted.slice(0, edit.start) + edit.text + adapted.slice(edit.end);
  adapted = prelude + adapted + nativeViewportBridge() + nativeContextBridge();
  assertThoughtdagAdapter(ast, parse(adapted));
  return {
    source: adapted,
    sourceSha256: digest(original),
    adaptedSha256: digest(adapted),
    changes: [
      'AST-guard duplicate project/session navigation and standalone landing composer in native session canvases; preserve original CanvasChat insights and graph generation.',
      'Keep the original compact project tool in global/workspace graph surfaces and delegate host navigation to DSH.',
      'Seed the exact native session through the original serialized live-mirror handler and canonical graph importer.',
      'Retain original seq polling, incremental log reads, ledger deduplication, subagent import and subsequent live append.',
      'Preserve the original graph, node editors, FocusPanel, connections, camera and generation pipeline.',
      'Route embedded harness graph generation through original fresh creation so compiled graph context is injected.',
      'Notify the native conversation surface only after successful graph generation and original turn stamping.',
      'Fit the original ReactFlow viewport on embedded visibility/size changes, with bounded node readiness and interaction guards.',
      'Cap embedded automatic fits at zoom 1, including original delayed fits, while retaining original manual zoom limits.',
      'Expose a read-only native conversation compile bridge using the original 0.5.21 buildContext, stale selection and context-bundle compiler.',
      'Suppress only the standalone plugin update probe and installation toast; retain release notes and ordinary error toasts.',
      'Publish a stable nexus-entry.js and map upstream chunk back-references to the same module identity.',
    ],
  };
}

/** The host overlays this shell and the one adapted asset; all other files can use the original package. */
export function reviewedThoughtdagHtml(original) {
  if (digest(original) !== REVIEWED_HTML_SHA256
    || !original.includes(`src="/thoughtdag/${THOUGHTDAG_SOURCE_ASSET}"`)) {
    throw new Error('ThoughtDAG client adapter requires the reviewed 0.5.21 HTML SHA256');
  }
  const entry = `<script type="module" crossorigin src="/thoughtdag/${THOUGHTDAG_SOURCE_ASSET}"></script>`;
  if (original.indexOf(entry) !== original.lastIndexOf(entry)) throw new Error('ThoughtDAG HTML entry is not unique');
  // Lazy chunks import the main bundle for its stores/exports. Merely renaming
  // the initial script would load the original entry a second time. An exact
  // import map resolves those static/dynamic back-references to this one module.
  const imports = { [`/thoughtdag/${THOUGHTDAG_SOURCE_ASSET}`]: `/thoughtdag/${THOUGHTDAG_CLIENT_ASSET}` };
  return original.replace(entry, `<script type="importmap">${JSON.stringify({ imports })}</script>\n    `
    + `<script type="module" crossorigin src="/thoughtdag/${THOUGHTDAG_CLIENT_ASSET}"></script>`);
}

function assertThoughtdagAdapter(original, adapted) {
  const changed = new Set(['M0e', 'ade', 'qV', 'm7', 'Hi', 'XP', 'g0e']);
  for (const node of original.statements) {
    if (!ts.isFunctionDeclaration(node) || !node.name || changed.has(node.name.text)) continue;
    if (namedFunction(adapted, node.name.text).getText(adapted) !== node.getText(original)) {
      throw new Error(`ThoughtDAG client adapter changed original implementation: ${node.name.text}`);
    }
  }
  for (const [name, insertion] of [
    ['m7', EMBEDDED_FRESH_ROUTE], ['Hi', GENERATED_SESSION_NOTIFICATION],
  ]) {
    const source = namedFunction(adapted, name).getText(adapted);
    if (!source.includes(insertion)
      || source.replace(insertion, '') !== namedFunction(original, name).getText(original)) {
      throw new Error(`ThoughtDAG client adapter changed original harness pipeline: ${name}`);
    }
  }
  const automaticFit = namedFunction(adapted, 'XP').getText(adapted);
  if (!automaticFit.includes(EMBEDDED_FIT_MAX_ZOOM)
    || automaticFit.indexOf(EMBEDDED_FIT_MAX_ZOOM) !== automaticFit.lastIndexOf(EMBEDDED_FIT_MAX_ZOOM)
    || automaticFit.replace(EMBEDDED_FIT_MAX_ZOOM, ORIGINAL_FIT_MAX_ZOOM)
      !== namedFunction(original, 'XP').getText(original)) {
    throw new Error('ThoughtDAG client adapter changed original automatic fit implementation');
  }
  if (namedFunction(adapted, 'g0e').getText(adapted) !== SUPPRESSED_PLUGIN_UPDATE) {
    throw new Error('ThoughtDAG client adapter changed the reviewed updater suppression');
  }
  const flow = ast => one(descendants(namedFunction(ast, 'M0e'), node => ts.isCallExpression(node)
    && property(node.arguments[1], 'nodeTypes') && property(node.arguments[1], 'edgeTypes')), 'original ReactFlow renderer');
  if (flow(original).getText(original) !== flow(adapted).getText(adapted)) {
    throw new Error('ThoughtDAG client adapter changed original ReactFlow renderer');
  }
  const focus = ast => one(componentCalls(namedFunction(ast, 'M0e'), 'Wce'), 'original FocusPanel call').getText(ast);
  if (focus(original) !== focus(adapted)) throw new Error('ThoughtDAG client adapter changed original FocusPanel');
  const insight = ast => one(componentCalls(namedFunction(ast, 'M0e'), 'fue'), 'original CanvasChat call').getText(ast);
  if (insight(original) !== insight(adapted)) throw new Error('ThoughtDAG client adapter changed original CanvasChat');
  if (namedFunction(original, 'es').getText(original) !== 'function es(e,t,n,a,r,s,o){return lv(e,t,n,"record",a,r,s,o)}') {
    throw new Error('ThoughtDAG client adapter: original record context wrapper changed');
  }
}

function nativeViewportBridge() {
  return `
// The original ReactFlow instance owns all viewport operations. Size messages
// never alter nodes or re-fit on session updates, panning, selection or dragging.
function __nexusThoughtdagResizeView(getInstance){
  if(!__nexusThoughtdagEmbedded)return;
  let disposed=false,parentVisible=true,wasHidden=true,lastSize="";
  let pending=false,timer=0,frame=0,expiry=0,unsubscribe=null;
  const pointers=new Set();
  const cancelScheduled=()=>{
    clearTimeout(timer);timer=0;
    cancelAnimationFrame(frame);frame=0;
  };
  const stop=()=>{
    pending=false;cancelScheduled();clearTimeout(expiry);expiry=0;
    unsubscribe?.();unsubscribe=null;
  };
  const size=()=>{
    if(!parentVisible||document.hidden)return null;
    const flow=document.querySelector(".react-flow");
    if(!flow)return null;
    const roots=[flow];
    try{if(window.frameElement)roots.push(window.frameElement)}catch{return null}
    for(const root of roots){
      const rect=root.getBoundingClientRect();
      if(rect.width<2||rect.height<2)return null;
      for(let element=root;element;element=element.parentElement){
        const style=element.ownerDocument.defaultView.getComputedStyle(element);
        if(style.display==="none"||style.visibility==="hidden"
          ||style.visibility==="collapse")return null;
      }
    }
    const rect=flow.getBoundingClientRect();
    return Math.round(rect.width)+":"+Math.round(rect.height);
  };
  const schedule=()=>{
    if(disposed||!pending||timer||frame)return;
    timer=setTimeout(()=>{
      timer=0;frame=requestAnimationFrame(()=>{
        frame=requestAnimationFrame(flush);
      });
    },80);
  };
  const flush=()=>{
    frame=0;
    if(disposed||!pending)return;
    const currentSize=size();
    if(!currentSize){wasHidden=true;stop();return}
    if(!wasHidden&&currentSize===lastSize){stop();return}
    const instance=getInstance(),nodes=instance?.getNodes?.()??[];
    if(!instance?.viewportInitialized||!nodes.some(node=>!node.hidden
      &&node.measured?.width>0&&node.measured?.height>0)
      ||pointers.size||nodes.some(node=>node.dragging)){
      schedule();return;
    }
    // With initialized nodes, upstream fitView queues the native measurement
    // update itself. An immediate fit avoids a resize animation fighting a pan.
    stop();lastSize=currentSize;wasHidden=false;
    Promise.resolve(instance.fitView({
      duration:0,padding:.2,minZoom:.04,maxZoom:1
    })).catch(()=>{wasHidden=true});
  };
  const request=()=>{
    if(disposed)return;
    stop();pending=true;
    // Native projection can arrive after frame load. Wait for its first
    // measured nodes only during this request, never a permanent seq listener.
    expiry=setTimeout(stop,2500);
    unsubscribe=se.subscribe(()=>{if(pending)schedule()});
    schedule();
  };
  const message=event=>{
    if(event.source!==window.parent||event.origin!==window.location.origin
      ||event.data?.source!=="dsh-thoughtdag"
      ||event.data.type!=="td:resize-view")return;
    if(event.data.visible===false){
      parentVisible=false;wasHidden=true;stop();return;
    }
    parentVisible=true;request();
  };
  const pointerDown=event=>pointers.add(event.pointerId);
  const pointerUp=event=>{pointers.delete(event.pointerId);if(pending)schedule()};
  const blur=()=>{pointers.clear();if(pending)schedule()};
  const visibility=()=>{
    if(document.hidden){wasHidden=true;stop()}
    else if(parentVisible)request();
  };
  window.addEventListener("message",message);
  window.addEventListener("pointerdown",pointerDown,true);
  window.addEventListener("pointerup",pointerUp,true);
  window.addEventListener("pointercancel",pointerUp,true);
  window.addEventListener("blur",blur);
  document.addEventListener("visibilitychange",visibility);
  request();
  return()=>{
    disposed=true;stop();pointers.clear();
    window.removeEventListener("message",message);
    window.removeEventListener("pointerdown",pointerDown,true);
    window.removeEventListener("pointerup",pointerUp,true);
    window.removeEventListener("pointercancel",pointerUp,true);
    window.removeEventListener("blur",blur);
    document.removeEventListener("visibilitychange",visibility);
  };
}
`;
}

function nativeContextBridge() {
  return `
// Native UI reads the original graph compiler. This bridge never starts a model
// call, creates a session, mutates the graph, or replaces DSH request history.
if(__nexusThoughtdagSessionId){
  window.addEventListener("message",async event=>{
    const request=event.data;
    if(event.source!==window.parent||event.origin!==window.location.origin
      ||request?.source!=="dsh-thoughtdag"||request.type!=="td:compile-context"
      ||typeof request.requestId!=="string")return;
    const reply=body=>window.parent.postMessage({
      source:"dsh-thoughtdag",type:"td:compiled-context",requestId:request.requestId,...body
    },window.location.origin);
    try{
      if(request.sessionId!==__nexusThoughtdagSessionId)throw new Error("图谱会话不匹配");
      if(typeof request.question!=="string"||!request.question.trim())throw new Error("问题不能为空");
      await EC();
      const state=se.getState(),projects=Zt.getState();
      const project=projects.projects.find(item=>item.id===projects.activeId);
      const source=project?.sourceSession;
      const entries=source?[source,...source.chapters??[],...source.branches??[]]:[];
      const explicit=typeof request.anchorNodeId==="string"?request.anchorNodeId:null;
      const tail=entries.find(item=>item.sessionId===__nexusThoughtdagSessionId)?.tailNodeId;
      const anchorId=explicit??state.selectedNodeId??tail??null;
      if(anchorId&&!state.nodes.some(node=>node.id===anchorId))throw new Error("图谱节点不存在");
      const anchor=anchorId?state.nodes.find(node=>node.id===anchorId):null;
      // Empty sessions use a virtual root only for compilation, never persisted.
      const targetId=anchorId??"nexus-native-question";
      const nodes=anchor?state.nodes:[...state.nodes,{
        id:targetId,data:{question:"",response:"",attachments:[]}
      }];
      const branch=typeof request.branchContext==="string"?request.branchContext:undefined;
      const stale=ts(state),context=es(targetId,nodes,state.edges,branch,
        anchor?.data.excludedAttachmentIds,anchor?.data.includedAttachmentIds,stale);
      const question=request.question;
      const messages=[...context.messages,{role:"user",content:question}];
      const sources=[...context.sources,{layer:"chain",part:"question"}];
      const bundle=await P0e(targetId,nodes,state.edges,{
        projectId:project?.id,task:question,now:new Date().toISOString(),
        branchContext:branch,staleIds:stale,
        preferredModel:anchor?.data.model??oe.getState().selectedModel
      });
      reply({ok:true,plan:{
        sessionId:__nexusThoughtdagSessionId,projectId:project?.id??null,
        anchorNodeId:anchorId,question,messages,images:context.images,
        sources,imageSources:context.imageSources,layerTokens:context.layerTokens,
        contextHash:OW(messages,context.images),bundle
      }});
    }catch(error){
      reply({ok:false,error:error instanceof Error?error.message:String(error)});
    }
  });
}
`;
}
