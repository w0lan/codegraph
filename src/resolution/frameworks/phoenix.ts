/**
 * Phoenix Framework Resolver (Elixir)
 *
 * Turns a Phoenix router (`router.ex`, or any module that does
 * `use Phoenix.Router` / `use <App>Web, :router`) into `route` nodes plus
 * references to the controller actions / LiveView modules that serve them,
 * and into `component` nodes for `pipeline :name do … end` so that
 * `pipe_through :name` has something to point at.
 *
 * Scaffolding (regex route extraction, `scope` nesting via do/end balance)
 * follows the shape proposed in upstream PR #1229; the resolution half is
 * rebuilt on top of this repo's Elixir extractor, which gives every function
 * a real `Full.Module::fun` qualifiedName. That means:
 *
 *   - controller names are expanded through the router's own `alias`
 *     directives (`alias A.B.C`, `alias A.B.C, as: D`, `alias A.{B, C}`)
 *     before they are emitted, so `Controller#index` inside
 *     `alias AgreementsWeb.AgreementsInformingController, as: Controller`
 *     resolves to the real module — not to whatever file happens to be
 *     called `controller.ex`;
 *   - resolution is an exact qualifiedName lookup, so it works in umbrella
 *     apps (`apps/<app>_web/lib/<app>_web/…`) where the file path does not
 *     mirror the module name and there is no single `lib/` root;
 *   - both the space form (`get "/x", C, :a`) and the parenthesised form
 *     (`get("/x", C, :a)`) of every macro are recognised — the parenthesised
 *     form is what `mix format` produces and what real routers use.
 *
 * A wrong edge is worse than no edge: when a name is ambiguous (two modules
 * with the same last segment and no way to tell them apart) the reference is
 * left unresolved.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

// ---------------------------------------------------------------------------
// RESTful route expansion tables
// ---------------------------------------------------------------------------

const RESTFUL_ROUTES: Record<string, { method: string; path: (r: string) => string }> = {
  index:   { method: 'GET',    path: (r) => `/${r}` },
  create:  { method: 'POST',   path: (r) => `/${r}` },
  new:     { method: 'GET',    path: (r) => `/${r}/new` },
  show:    { method: 'GET',    path: (r) => `/${r}/:id` },
  edit:    { method: 'GET',    path: (r) => `/${r}/:id/edit` },
  update:  { method: 'PATCH',  path: (r) => `/${r}/:id` },
  delete:  { method: 'DELETE', path: (r) => `/${r}/:id` },
};

const PLURAL_RESOURCE_ACTIONS   = ['index', 'create', 'new', 'show', 'edit', 'update', 'delete'] as const;
const SINGULAR_RESOURCE_ACTIONS = ['create', 'new', 'show', 'edit', 'update', 'delete'] as const;

// ---------------------------------------------------------------------------
// Regex building blocks
// ---------------------------------------------------------------------------

/**
 * The gap between a router macro and its first argument. Elixir macros take
 * both `macro arg` and `macro(arg)`; `mix format` emits the parenthesised form
 * and real-world routers are full of it, so every pattern must accept both.
 */
const OPEN = String.raw`(?:\s*\(\s*|\s+)`;
/** A module alias: `Foo`, `Foo.Bar.Baz`. */
const MOD = String.raw`[A-Z]\w*(?:\.[A-Z]\w*)*`;
/**
 * A single- or double-quoted literal, captured as (quote)(body). `group` is the
 * 1-based index the QUOTE group will have in the finished pattern — the
 * backreference that closes the literal has to name it explicitly, since a
 * pattern may capture something (an HTTP verb) before the string starts.
 */
const STR = (group: number) => `(['"])([^'"]*)\\${group}`;

/**
 * A Phoenix router module: the conventional `router.ex`, or any file that
 * does `use Phoenix.Router` / `use <App>Web, :router` (routers split out of
 * the main one — e.g. `informing_routes.ex` — are common).
 */
const ROUTER_USE = /(?:^|\n)\s*use\s+(?:Phoenix\.Router\b|[A-Z]\w*(?:\.[A-Z]\w*)*\s*,\s*:router\b)/;

function isRouterSource(filePath: string, content: string): boolean {
  const base = filePath.split(/[\\/]/).pop() ?? '';
  if (base === 'router.ex') return true;
  return ROUTER_USE.test(content);
}

// ---------------------------------------------------------------------------
// Line mapping — route nodes carry absolute file lines, also inside scopes
// ---------------------------------------------------------------------------

/** Byte offsets at which each line starts. */
function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** 1-based line number of an absolute offset. */
function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// ---------------------------------------------------------------------------
// `alias` table — router-local module shorthands
// ---------------------------------------------------------------------------

/**
 * Collect the router's `alias` directives so a bare controller name can be
 * expanded to its real module. Handles `alias A.B.C` (→ `C`), `alias A.B.C,
 * as: D` (→ `D`), and `alias A.{B, C}` (→ `B`, `C`).
 */
export function collectAliases(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = new RegExp(
    String.raw`\balias\s*\(?\s*(${MOD})(?:\.\{([^}]*)\}|\s*,\s*as:\s*(${MOD}))?`,
    'g'
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const base = m[1]!;
    const group = m[2];
    const asName = m[3];

    if (group !== undefined) {
      for (const raw of group.split(',')) {
        const seg = raw.trim();
        if (!/^[A-Z]\w*(?:\.[A-Z]\w*)*$/.test(seg)) continue;
        const last = seg.split('.').pop()!;
        map.set(last, `${base}.${seg}`);
      }
      continue;
    }

    const key = asName ?? base.split('.').pop()!;
    map.set(key, base);
  }
  return map;
}

/** Expand a controller/module name through the router's alias table. */
function expandAlias(name: string, aliases: Map<string, string>): string {
  const dot = name.indexOf('.');
  const head = dot === -1 ? name : name.slice(0, dot);
  const target = aliases.get(head);
  if (!target) return name;
  return dot === -1 ? target : target + name.slice(dot);
}

// ---------------------------------------------------------------------------
// scope block discovery
// ---------------------------------------------------------------------------

interface ScopeBlock {
  scopeStart: number;
  doPos: number;
  endPos: number;
  pathPrefix: string;
  modulePrefix: string;
}

/**
 * Find the matching `end` for a `do` at `doPos` by tracking block balance.
 *
 * `do:` (the keyword-list one-liner form, `def f(x), do: y`) is NOT a block
 * opener, and `fn … end` IS a block — both matter inside a real router, where
 * `pipeline` bodies and `if Mix.env == :test do` branches sit between scopes.
 */
export function findMatchingEnd(text: string, doPos: number): number {
  const re = /\bdo\b(?!:)|\bend\b|\bfn\b/g;
  re.lastIndex = doPos;
  let depth = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    const tok = m[0];
    if (tok === 'end') {
      if (depth === 0) return m.index + 3;
      depth--;
    } else {
      depth++;
    }
  }

  return text.length;
}

/**
 * Find the top-level `scope … do … end` blocks in `text`. Nested scopes are
 * reached by recursing into a block's body, not by this scan.
 */
export function findScopeBlocks(text: string): ScopeBlock[] {
  const blocks: ScopeBlock[] = [];
  // scope "/p", Mod do | scope "/p" do | scope Mod do | scope("/p", Mod) do
  // | scope path: "/p", alias: Mod do   (+ trailing opts such as host:/assigns:,
  // which may push the `do` onto a following line).
  const re = new RegExp(
    String.raw`\bscope\b\s*\(?\s*(?:path:\s*)?(?:${STR(1)})?\s*,?\s*(?:alias:\s*)?(${MOD})?[\s\S]{0,400}?\bdo\b(?!:)`,
    'g'
  );
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    const pathPrefix = m[2] ?? '';
    const modulePrefix = m[3] ?? '';
    const doPos = re.lastIndex;
    const endPos = findMatchingEnd(text, doPos);

    blocks.push({ scopeStart: m.index, doPos, endPos, pathPrefix, modulePrefix });
    re.lastIndex = endPos;
  }

  return blocks;
}

function combinePathPrefix(parent: string, child: string): string {
  if (!child || child === '/') return parent || '';
  if (!parent || parent === '/') return child;
  const p = parent.replace(/\/$/, '');
  return p + (child.startsWith('/') ? child : '/' + child);
}

function combineModulePrefix(parent: string, child: string): string {
  if (!child) return parent;
  if (!parent) return child;
  return `${parent}.${child}`;
}

function applyPath(prefix: string, routePath: string): string {
  if (!prefix || prefix === '/') return routePath;
  const p = prefix.replace(/\/$/, '');
  const joined = p + (routePath.startsWith('/') ? routePath : '/' + routePath);
  return joined.length > 1 ? joined.replace(/\/+$/, '') || '/' : joined;
}

/**
 * Phoenix concatenates the enclosing `scope`'s alias onto the controller atom
 * verbatim; the router's own `alias` directives only apply when there is no
 * scope alias to prepend.
 */
function applyModule(prefix: string, mod: string, aliases: Map<string, string>): string {
  if (prefix) return `${prefix}.${mod}`;
  return expandAlias(mod, aliases);
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

interface EmitCtx {
  filePath: string;
  now: number;
  aliases: Map<string, string>;
  starts: number[];
  nodes: Node[];
  refs: UnresolvedRef[];
}

function makeRouteNode(ctx: EmitCtx, line: number, method: string, routePath: string): Node {
  return {
    id:            `route:${ctx.filePath}:${line}:${method}:${routePath}`,
    kind:          'route',
    name:          `${method} ${routePath}`,
    qualifiedName: `${ctx.filePath}::route:${method}:${routePath}`,
    filePath:      ctx.filePath,
    startLine:     line,
    endLine:       line,
    startColumn:   0,
    endColumn:     0,
    language:      'elixir',
    updatedAt:     ctx.now,
  };
}

function addRef(ctx: EmitCtx, fromNodeId: string, referenceName: string, line: number): void {
  ctx.refs.push({
    fromNodeId,
    referenceName,
    referenceKind: 'references',
    line,
    column: 0,
    filePath: ctx.filePath,
    language: 'elixir',
  });
}

/**
 * Emit one route node plus its handler reference and the pipeline references
 * inherited from the enclosing scopes.
 */
function emitRoute(
  ctx: EmitCtx,
  line: number,
  method: string,
  routePath: string,
  handlerRef: string | null,
  pipelines: readonly string[]
): void {
  const node = makeRouteNode(ctx, line, method, routePath);
  ctx.nodes.push(node);
  if (handlerRef) addRef(ctx, node.id, handlerRef, line);
  for (const pipe of pipelines) {
    // A `pipe_through` list may name a pipeline (`:browser`) or, in newer
    // Phoenix, a plug module outright (`pipe_through [:app_layout, MyPlug]`).
    // The first points at the pipeline node; the second at the plug module.
    const ref = /^[A-Z]/.test(pipe) ? expandAlias(pipe, ctx.aliases) : `:${pipe}`;
    addRef(ctx, node.id, ref, line);
  }
}

/** `only:` / `except:` filtering shared by `resources` and `resource`. */
function filterActions(defaults: readonly string[], tail: string): string[] {
  const onlyMatch = tail.match(/only:\s*\[([^\]]*)\]/);
  const exceptMatch = tail.match(/except:\s*\[([^\]]*)\]/);
  if (onlyMatch) {
    const keep = new Set(onlyMatch[1]!.split(',').map((s) => s.trim().replace(/^:/, '')));
    return defaults.filter((a) => keep.has(a));
  }
  if (exceptMatch) {
    const skip = new Set(exceptMatch[1]!.split(',').map((s) => s.trim().replace(/^:/, '')));
    return defaults.filter((a) => !skip.has(a));
  }
  return [...defaults];
}

// Patterns are built once — they carry the /g flag, so `lastIndex` is reset
// explicitly before every scan.
const RE_VERB = new RegExp(
  String.raw`\b(get|post|put|patch|delete|options|head)${OPEN}${STR(2)}\s*,\s*(${MOD})\s*,\s*:(\w+)`,
  'g'
);
const RE_MATCH = new RegExp(
  String.raw`\bmatch${OPEN}:(\*|\w+)\s*,\s*${STR(2)}\s*,\s*(${MOD})\s*,\s*:(\w+)`,
  'g'
);
const RE_RESOURCES = new RegExp(
  String.raw`\bresources${OPEN}${STR(1)}\s*,\s*(${MOD})`,
  'g'
);
const RE_RESOURCE = new RegExp(
  String.raw`\bresource(?!s)${OPEN}${STR(1)}\s*,\s*(${MOD})`,
  'g'
);
const RE_LIVE = new RegExp(
  String.raw`\blive${OPEN}${STR(1)}\s*,\s*(${MOD})(?:\s*,\s*:(\w+))?`,
  'g'
);
const RE_FORWARD = new RegExp(String.raw`\bforward${OPEN}${STR(1)}\s*,\s*(${MOD})`, 'g');
const RE_PIPELINE = new RegExp(String.raw`\bpipeline${OPEN}:(\w+)\s*\)?\s*do\b`, 'g');
const RE_PIPE_THROUGH = new RegExp(String.raw`\bpipe_through${OPEN}(?::(\w+)|\[([^\]]*)\])`, 'g');

/**
 * The option list trailing a `resources`/`resource` call, which may carry
 * `only:`/`except:` behind other options (`name:`, `param:`) and may wrap onto
 * continuation lines. It ends at the `do` that opens a nested block, or at the
 * first line that does not end in a comma.
 */
function optionsTail(text: string, from: number): string {
  let i = from;
  let end = from;
  while (i <= text.length) {
    const nl = text.indexOf('\n', i);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(i, lineEnd);
    const doAt = line.search(/\bdo\b(?!:)/);
    if (doAt !== -1) return text.slice(from, i + doAt);
    end = lineEnd;
    if (!/,\s*$/.test(line) || nl === -1) break;
    i = nl + 1;
  }
  return text.slice(from, end);
}

/** Pipeline names named by every `pipe_through` at this scope level. */
function collectPipeThrough(text: string): string[] {
  const out: string[] = [];
  RE_PIPE_THROUGH.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_PIPE_THROUGH.exec(text)) !== null) {
    if (m[1]) {
      out.push(m[1]);
    } else if (m[2]) {
      for (const raw of m[2].split(',')) {
        const name = raw.trim().replace(/^:/, '');
        // Pipeline atom (`:browser`) or plug module (`MyApp.SomePlug`) — a
        // half-parsed fragment of anything else is dropped rather than turned
        // into a reference no node could ever carry.
        if (/^[a-z_]\w*$/.test(name) || /^[A-Z]\w*(?:\.[A-Z]\w*)*$/.test(name)) out.push(name);
      }
    }
  }
  return out;
}

/**
 * Emit every route declared directly at one scope level.
 *
 * `text` is a slice of the (comment-stripped) file starting at absolute offset
 * `base`, so line numbers stay absolute.
 */
function processRoutes(
  ctx: EmitCtx,
  text: string,
  base: number,
  pathPrefix: string,
  modulePrefix: string,
  pipelines: readonly string[]
): void {
  const lineOf = (idx: number) => lineAt(ctx.starts, base + idx);
  let m: RegExpExecArray | null;

  // ----- pipeline :name do … end (declaration, not a route) -----
  RE_PIPELINE.lastIndex = 0;
  while ((m = RE_PIPELINE.exec(text)) !== null) {
    const name = m[1]!;
    const line = lineOf(m.index);
    ctx.nodes.push({
      id:            `pipeline:${ctx.filePath}:${line}:${name}`,
      kind:          'component',
      name:          `:${name}`,
      qualifiedName: `${ctx.filePath}::pipeline:${name}`,
      filePath:      ctx.filePath,
      startLine:     line,
      endLine:       line,
      startColumn:   0,
      endColumn:     0,
      language:      'elixir',
      updatedAt:     ctx.now,
    });
  }

  // ----- get/post/put/patch/delete/options/head "/path", Controller, :action -----
  RE_VERB.lastIndex = 0;
  while ((m = RE_VERB.exec(text)) !== null) {
    const method = m[1]!.toUpperCase();
    const routePath = m[3]!;
    const controller = m[4]!;
    const action = m[5]!;
    const line = lineOf(m.index);
    emitRoute(
      ctx,
      line,
      method,
      applyPath(pathPrefix, routePath),
      `${applyModule(modulePrefix, controller, ctx.aliases)}#${action}`,
      pipelines
    );
  }

  // ----- match :verb | :*, "/path", Controller, :action -----
  RE_MATCH.lastIndex = 0;
  while ((m = RE_MATCH.exec(text)) !== null) {
    const verb = m[1]!;
    const method = verb === '*' ? 'ANY' : verb.toUpperCase();
    const routePath = m[3]!;
    const controller = m[4]!;
    const action = m[5]!;
    const line = lineOf(m.index);
    emitRoute(
      ctx,
      line,
      method,
      applyPath(pathPrefix, routePath),
      `${applyModule(modulePrefix, controller, ctx.aliases)}#${action}`,
      pipelines
    );
  }

  // ----- resources "/posts", Controller (plural, 7 actions) -----
  RE_RESOURCES.lastIndex = 0;
  while ((m = RE_RESOURCES.exec(text)) !== null) {
    const resName = m[2]!.replace(/^\//, '');
    const controller = m[3]!;
    const actions = filterActions(PLURAL_RESOURCE_ACTIONS, optionsTail(text, m.index + m[0].length));
    const line = lineOf(m.index);
    const fullCtrl = applyModule(modulePrefix, controller, ctx.aliases);
    for (const action of actions) {
      const spec = RESTFUL_ROUTES[action]!;
      emitRoute(
        ctx,
        line,
        spec.method,
        applyPath(pathPrefix, spec.path(resName)),
        `${fullCtrl}#${action}`,
        pipelines
      );
    }
  }

  // ----- resource "/profile", Controller (singular, 6 actions) -----
  RE_RESOURCE.lastIndex = 0;
  while ((m = RE_RESOURCE.exec(text)) !== null) {
    const resName = m[2]!.replace(/^\//, '');
    const controller = m[3]!;
    const actions = filterActions(SINGULAR_RESOURCE_ACTIONS, optionsTail(text, m.index + m[0].length));
    const line = lineOf(m.index);
    const fullCtrl = applyModule(modulePrefix, controller, ctx.aliases);
    for (const action of actions) {
      const spec = RESTFUL_ROUTES[action]!;
      emitRoute(
        ctx,
        line,
        spec.method,
        applyPath(pathPrefix, spec.path(resName)),
        `${fullCtrl}#${action}`,
        pipelines
      );
    }
  }

  // ----- live "/path", LiveModule[, :live_action] -----
  // The trailing atom is a live_action, NOT a function on the module: a
  // LiveView has no `def index/2`. The reference therefore names the MODULE,
  // which is what actually handles the request (mount/render/handle_event).
  RE_LIVE.lastIndex = 0;
  while ((m = RE_LIVE.exec(text)) !== null) {
    const routePath = m[2]!;
    const liveMod = m[3]!;
    const line = lineOf(m.index);
    const fullPath = applyPath(pathPrefix, routePath);
    const refName = applyModule(modulePrefix, liveMod, ctx.aliases);
    for (const method of ['GET', 'POST']) {
      emitRoute(ctx, line, method, fullPath, refName, pipelines);
    }
  }

  // ----- forward "/path", Plug -----
  RE_FORWARD.lastIndex = 0;
  while ((m = RE_FORWARD.exec(text)) !== null) {
    const routePath = m[2]!;
    const target = m[3]!;
    const line = lineOf(m.index);
    emitRoute(
      ctx,
      line,
      'FORWARD',
      applyPath(pathPrefix, routePath),
      applyModule(modulePrefix, target, ctx.aliases),
      pipelines
    );
  }
}

/** Walk one scope level, then recurse into each nested `scope … do … end`. */
function processLevel(
  ctx: EmitCtx,
  text: string,
  base: number,
  pathPrefix: string,
  modulePrefix: string,
  inheritedPipelines: readonly string[]
): void {
  const scopes = findScopeBlocks(text);

  // `pipe_through` applies to the whole scope it sits in — and, in Phoenix, to
  // the scopes nested inside it — not just to the next route. Collect it from
  // THIS level's own text (the gaps between nested scopes); a nested scope's
  // own `pipe_through` is picked up when that scope is walked.
  let ownText = '';
  let cursor = 0;
  for (const scope of scopes) {
    ownText += text.slice(cursor, scope.scopeStart);
    cursor = scope.endPos;
  }
  ownText += text.slice(cursor);
  const pipelines = [...new Set([...inheritedPipelines, ...collectPipeThrough(ownText)])];

  let lastEnd = 0;
  for (const scope of scopes) {
    processRoutes(
      ctx,
      text.slice(lastEnd, scope.scopeStart),
      base + lastEnd,
      pathPrefix,
      modulePrefix,
      pipelines
    );

    const innerEnd = Math.max(scope.doPos, scope.endPos - 3);
    processLevel(
      ctx,
      text.slice(scope.doPos, innerEnd),
      base + scope.doPos,
      combinePathPrefix(pathPrefix, scope.pathPrefix),
      combineModulePrefix(modulePrefix, scope.modulePrefix),
      pipelines
    );

    lastEnd = scope.endPos;
  }

  processRoutes(ctx, text.slice(lastEnd), base + lastEnd, pathPrefix, modulePrefix, pipelines);
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

/**
 * Arities tried when the project's Elixir extractor qualifies function names
 * with an arity (`index/2`). Controller actions are `/2`, LiveView callbacks
 * `/3`; the rest are a cheap indexed-lookup tail.
 */
const CANDIDATE_ARITIES = [2, 3, 1, 0, 4, 5, 6, 7, 8, 9];

function isElixirFunction(n: Node): boolean {
  return n.language === 'elixir' && (n.kind === 'function' || n.kind === 'method');
}

/** Length of the shared leading path segments — used to prefer the same umbrella app. */
function sharedPathScore(a: string, b: string): number {
  const as = a.split('/');
  const bs = b.split('/');
  let i = 0;
  while (i < as.length && i < bs.length && as[i] === bs[i]) i++;
  return i;
}

/**
 * Pick one node: a single candidate wins outright; several win only when one
 * of them is unambiguously closer to the router file. Otherwise, nothing.
 */
function pickOne(candidates: Node[], fromFile: string): Node | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;

  let best: Node | null = null;
  let bestScore = -1;
  let tied = false;
  for (const n of candidates) {
    const score = sharedPathScore(n.filePath, fromFile);
    if (score > bestScore) {
      bestScore = score;
      best = n;
      tied = false;
    } else if (score === bestScore) {
      tied = true;
    }
  }
  return tied ? null : best;
}

/** Exact `Module::action` lookup, arity-tolerant. */
function findByQualifiedName(
  context: ResolutionContext,
  module: string,
  action: string,
  fromFile: string
): Node | null {
  const exact = context.getNodesByQualifiedName(`${module}::${action}`).filter(isElixirFunction);
  const hit = pickOne(exact, fromFile);
  if (hit) return hit;

  for (const arity of CANDIDATE_ARITIES) {
    const withArity = context
      .getNodesByQualifiedName(`${module}::${action}/${arity}`)
      .filter(isElixirFunction);
    const chosen = pickOne(withArity, fromFile);
    if (chosen) return chosen;
  }
  return null;
}

/**
 * Last resort for a controller name the router never qualified (no scope
 * alias, no `alias` directive): accept a module whose LAST segment matches,
 * but only when that leaves exactly one candidate.
 */
function findBySuffix(
  context: ResolutionContext,
  module: string,
  action: string,
  fromFile: string
): Node | null {
  const named: Node[] = [...context.getNodesByName(action)];
  for (const arity of CANDIDATE_ARITIES) {
    named.push(...context.getNodesByName(`${action}/${arity}`));
  }
  const suffix = `.${module}::`;
  const candidates = named.filter(
    (n) => isElixirFunction(n) && n.qualifiedName.includes(suffix)
  );
  return pickOne(candidates, fromFile);
}

/** The `namespace` node for an Elixir module, exact then last-segment match. */
function findModuleNode(
  context: ResolutionContext,
  module: string,
  fromFile: string
): Node | null {
  const exact = context
    .getNodesByQualifiedName(module)
    .filter((n) => n.language === 'elixir' && n.kind === 'namespace');
  const hit = pickOne(exact, fromFile);
  if (hit) return hit;

  const byName = context
    .getNodesByName(module)
    .filter((n) => n.language === 'elixir' && n.kind === 'namespace');
  const named = pickOne(byName, fromFile);
  if (named) return named;

  if (module.includes('.')) return null;
  const suffix = `.${module}`;
  const bySuffix = context
    .getNodesByKind('namespace')
    .filter((n) => n.language === 'elixir' && n.qualifiedName.endsWith(suffix));
  return pickOne(bySuffix, fromFile);
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const PHOENIX_DEP = /\{\s*:phoenix\s*[,}]/;
/** Bound the detect() scan so a huge repo can't turn detection into a file walk. */
const MAX_DETECT_FILES = 40;

function mixDeclaresPhoenix(context: ResolutionContext, mixPath: string): boolean {
  const content = context.readFile(mixPath);
  return content !== null && PHOENIX_DEP.test(content);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const phoenixResolver: FrameworkResolver = {
  name: 'phoenix',
  languages: ['elixir'],

  detect(context: ResolutionContext): boolean {
    // 1. `{:phoenix, "~> 1.7"}` in the root mix.exs …
    if (mixDeclaresPhoenix(context, 'mix.exs')) return true;

    // … or in any umbrella child's mix.exs (an umbrella root often lists no
    // deps of its own — api_agreements_gratka does not).
    for (const app of context.listDirectories?.('apps') ?? []) {
      if (mixDeclaresPhoenix(context, `apps/${app}/mix.exs`)) return true;
    }

    // 2. A fetched dependency.
    if (context.fileExists('deps/phoenix')) return true;

    // 3. A router module, wherever it lives (umbrella layouts put it at
    //    apps/<app>_web/lib/<app>_web/router.ex — there is no single lib/).
    let scanned = 0;
    for (const file of context.getAllFiles()) {
      if (!file.endsWith('router.ex')) continue;
      if (++scanned > MAX_DETECT_FILES) break;
      const content = context.readFile(file);
      if (content && ROUTER_USE.test(content)) return true;
    }

    // 4. Conventional single-app layout, when the file list isn't available yet.
    for (const dir of context.listDirectories?.('lib') ?? []) {
      if (!dir.endsWith('_web')) continue;
      if (context.fileExists(`lib/${dir}/router.ex`)) return true;
      if (context.fileExists(`lib/${dir}/endpoint.ex`)) return true;
    }

    return false;
  },

  /**
   * `Controller#action` and `:pipeline` name no declared symbol, so without
   * this the pre-filter would drop them before `resolve()` ever runs.
   */
  claimsReference(name: string): boolean {
    return /^[A-Z][\w.]*#\w+$/.test(name) || /^:\w+$/.test(name);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.language !== 'elixir') return null;

    // pipe_through :api → the `pipeline :api do … end` node.
    const pipeMatch = ref.referenceName.match(/^:(\w+)$/);
    if (pipeMatch) {
      const candidates = context
        .getNodesByName(ref.referenceName)
        .filter((n) => n.kind === 'component' && n.language === 'elixir');
      const sameFile = candidates.filter((n) => n.filePath === ref.filePath);
      const chosen = sameFile[0] ?? (candidates.length === 1 ? candidates[0] : undefined);
      if (!chosen) return null;
      return { original: ref, targetNodeId: chosen.id, confidence: 0.9, resolvedBy: 'framework' };
    }

    // Controller#action → the controller's action function.
    const ca = ref.referenceName.match(/^([A-Z][\w.]*)#(\w+)$/);
    if (ca) {
      const module = ca[1]!;
      const action = ca[2]!;
      const target =
        findByQualifiedName(context, module, action, ref.filePath) ??
        (module.includes('.') ? null : findBySuffix(context, module, action, ref.filePath));
      if (!target) return null;
      return { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'framework' };
    }

    // `live` / `forward` name a MODULE (LiveView, forwarded plug router).
    if (/^[A-Z][\w.]*$/.test(ref.referenceName) && ref.referenceKind === 'references') {
      const module = ref.referenceName;
      const moduleNode = findModuleNode(context, module, ref.filePath);
      if (moduleNode) {
        return {
          original: ref,
          targetNodeId: moduleNode.id,
          confidence: 0.9,
          resolvedBy: 'framework',
        };
      }
      // No namespace node (module defined by a macro, or out of repo) — fall
      // back to the LiveView entry points before giving up.
      for (const callback of ['mount', 'render']) {
        const fn = findByQualifiedName(context, module, callback, ref.filePath);
        if (fn) {
          return { original: ref, targetNodeId: fn.id, confidence: 0.8, resolvedBy: 'framework' };
        }
      }
      return null;
    }

    return null;
  },

  extract(filePath: string, content: string): { nodes: Node[]; references: UnresolvedRef[] } {
    if (!filePath.endsWith('.ex') && !filePath.endsWith('.exs')) {
      return { nodes: [], references: [] };
    }
    // Route macros are only routes inside a router module. Scanning every
    // Elixir file for `get "/x", C, :a` would invent routes out of test
    // helpers and DSLs that happen to share the shape.
    if (!isRouterSource(filePath, content)) {
      return { nodes: [], references: [] };
    }

    const safe = stripCommentsForRegex(content, 'elixir');
    const ctx: EmitCtx = {
      filePath,
      now: Date.now(),
      aliases: collectAliases(safe),
      starts: computeLineStarts(safe),
      nodes: [],
      refs: [],
    };

    processLevel(ctx, safe, 0, '', '', []);

    return { nodes: ctx.nodes, references: ctx.refs };
  },
};
