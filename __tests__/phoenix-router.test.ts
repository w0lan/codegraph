import { describe, it, expect } from 'vitest';
import { phoenixResolver } from '../src/resolution/frameworks/phoenix';
import { stripCommentsForRegex } from '../src/resolution/strip-comments';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import type { Node } from '../src/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ROUTER = 'lib/my_app_web/router.ex';

/** Wrap a router body in the `use … :router` marker the extractor gates on. */
function router(body: string): string {
  return `defmodule MyAppWeb.Router do\n  use MyAppWeb, :router\n\n${body}\nend\n`;
}

function extract(src: string, filePath = ROUTER) {
  return phoenixResolver.extract!(filePath, src);
}

/** Handler references only (drops the `:pipeline` ones). */
function handlerRefs(references: UnresolvedRef[]): string[] {
  return references.filter((r) => !r.referenceName.startsWith(':')).map((r) => r.referenceName);
}

function fn(qualifiedName: string, filePath: string, name?: string): Node {
  return {
    id: `fn:${filePath}:${qualifiedName}`,
    kind: 'function',
    name: name ?? qualifiedName.split('::').pop()!,
    qualifiedName,
    filePath,
    language: 'elixir',
    startLine: 1,
    endLine: 2,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
  };
}

function ns(qualifiedName: string, filePath: string): Node {
  return {
    id: `ns:${filePath}:${qualifiedName}`,
    kind: 'namespace',
    name: qualifiedName,
    qualifiedName,
    filePath,
    language: 'elixir',
    startLine: 1,
    endLine: 20,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
  };
}

function makeContext(nodes: Node[], overrides: Partial<ResolutionContext> = {}): ResolutionContext {
  return {
    getNodesInFile: (fp) => nodes.filter((n) => n.filePath === fp),
    getNodesByName: (name) => nodes.filter((n) => n.name === name),
    getNodesByQualifiedName: (qn) => nodes.filter((n) => n.qualifiedName === qn),
    getNodesByKind: (kind) => nodes.filter((n) => n.kind === kind),
    getNodesByLowerName: (lower) => nodes.filter((n) => n.name.toLowerCase() === lower),
    getImportMappings: () => [],
    fileExists: () => false,
    readFile: () => null,
    getProjectRoot: () => '/test',
    getAllFiles: () => [...new Set(nodes.map((n) => n.filePath))],
    ...overrides,
  } as ResolutionContext;
}

function routeRef(referenceName: string, filePath = ROUTER): UnresolvedRef {
  return {
    fromNodeId: 'route:x',
    referenceName,
    referenceKind: 'references',
    line: 1,
    column: 0,
    filePath,
    language: 'elixir',
  };
}

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

describe('phoenixResolver.detect', () => {
  const base = makeContext([]);

  it('detects {:phoenix, …} in mix.exs', () => {
    const ctx = makeContext([], {
      readFile: (p) => (p === 'mix.exs' ? 'defp deps do [{:phoenix, "~> 1.7"}] end' : null),
    });
    expect(phoenixResolver.detect(ctx)).toBe(true);
  });

  it('detects phoenix declared only in an umbrella child mix.exs', () => {
    const ctx = makeContext([], {
      listDirectories: (rel) => (rel === 'apps' ? ['my_core', 'my_web'] : []),
      readFile: (p) =>
        p === 'apps/my_web/mix.exs' ? 'defp deps do [{:phoenix, "~> 1.3.2"}] end' : null,
    });
    expect(phoenixResolver.detect(ctx)).toBe(true);
  });

  it('detects a fetched deps/phoenix', () => {
    const ctx = makeContext([], { fileExists: (p) => p === 'deps/phoenix' });
    expect(phoenixResolver.detect(ctx)).toBe(true);
  });

  it('detects an umbrella router.ex by its `use …, :router`', () => {
    const ctx = makeContext([], {
      getAllFiles: () => ['apps/my_web/lib/my_web/router.ex'],
      readFile: (p) =>
        p === 'apps/my_web/lib/my_web/router.ex'
          ? 'defmodule MyWeb.Router do\n  use MyWeb, :router\nend\n'
          : null,
    });
    expect(phoenixResolver.detect(ctx)).toBe(true);
  });

  it('detects lib/*_web/router.ex in the conventional single-app layout', () => {
    const ctx = makeContext([], {
      listDirectories: (rel) => (rel === 'lib' ? ['my_app', 'my_app_web'] : []),
      fileExists: (p) => p === 'lib/my_app_web/router.ex',
    });
    expect(phoenixResolver.detect(ctx)).toBe(true);
  });

  it('returns false for a non-Phoenix Elixir project', () => {
    const ctx = makeContext([], {
      readFile: (p) => (p === 'mix.exs' ? 'defp deps do [{:plug, "~> 1.14"}] end' : null),
    });
    expect(phoenixResolver.detect(ctx)).toBe(false);
  });

  it('returns false when nothing at all is present', () => {
    expect(phoenixResolver.detect(base)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// claimsReference
// ---------------------------------------------------------------------------

describe('phoenixResolver.claimsReference', () => {
  it('claims AppWeb.UserController#index', () => {
    expect(phoenixResolver.claimsReference!('AppWeb.UserController#index')).toBe(true);
  });

  it('claims a bare Controller#action', () => {
    expect(phoenixResolver.claimsReference!('UserController#show')).toBe(true);
  });

  it('claims a :pipeline name', () => {
    expect(phoenixResolver.claimsReference!(':api')).toBe(true);
  });

  it('does not claim plain function names', () => {
    expect(phoenixResolver.claimsReference!('index')).toBe(false);
  });

  it('does not claim Rails-style lowercase controller#action', () => {
    expect(phoenixResolver.claimsReference!('users#index')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extract — HTTP verbs
// ---------------------------------------------------------------------------

describe('phoenixResolver.extract — HTTP verbs', () => {
  it('extracts a route node and reference for get "/path", Controller, :action', () => {
    const { nodes, references } = extract(router('  get "/users", UserController, :index'));
    const routes = nodes.filter((n) => n.kind === 'route');
    expect(routes).toHaveLength(1);
    expect(routes[0]!.name).toBe('GET /users');
    expect(routes[0]!.language).toBe('elixir');
    expect(references).toHaveLength(1);
    expect(references[0]!.referenceName).toBe('UserController#index');
    expect(references[0]!.referenceKind).toBe('references');
    expect(references[0]!.fromNodeId).toBe(routes[0]!.id);
  });

  it('extracts every HTTP verb', () => {
    const verbs = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;
    const src = router(verbs.map((v) => `  ${v} "/test", TestController, :action`).join('\n'));
    const { nodes, references } = extract(src);
    expect(nodes.filter((n) => n.kind === 'route').map((n) => n.name)).toEqual(
      verbs.map((v) => `${v.toUpperCase()} /test`)
    );
    expect(handlerRefs(references)).toEqual(verbs.map(() => 'TestController#action'));
  });

  it('accepts the parenthesised macro form mix format produces', () => {
    const { nodes, references } = extract(
      router('  get("/sources", LocationController, :sources)')
    );
    expect(nodes.filter((n) => n.kind === 'route').map((n) => n.name)).toEqual(['GET /sources']);
    expect(handlerRefs(references)).toEqual(['LocationController#sources']);
  });

  it('keeps a fully qualified controller name as written', () => {
    const { references } = extract(router('  get "/users", MyApp.UserController, :index'));
    expect(handlerRefs(references)).toEqual(['MyApp.UserController#index']);
  });

  it('records absolute file line numbers, including inside nested scopes', () => {
    const src = router(
      [
        '  scope "/api", MyApp do',
        '    scope "/v1", V1 do',
        '      get "/users", UserController, :index',
        '    end',
        '  end',
      ].join('\n')
    );
    const route = extract(src).nodes.find((n) => n.kind === 'route')!;
    // `use` is line 2, blank line 3, `scope "/api"` line 4, `scope "/v1"` line 5.
    expect(route.startLine).toBe(6);
    expect(src.split('\n')[route.startLine - 1]).toContain('get "/users"');
  });
});

// ---------------------------------------------------------------------------
// extract — resources / resource / match / forward
// ---------------------------------------------------------------------------

describe('phoenixResolver.extract — resource macros', () => {
  it('expands resources into all 7 default actions', () => {
    const { nodes, references } = extract(router('  resources "/posts", PostController'));
    expect(nodes.filter((n) => n.kind === 'route').map((n) => n.name)).toEqual([
      'GET /posts',
      'POST /posts',
      'GET /posts/new',
      'GET /posts/:id',
      'GET /posts/:id/edit',
      'PATCH /posts/:id',
      'DELETE /posts/:id',
    ]);
    expect(handlerRefs(references)).toEqual(
      ['index', 'create', 'new', 'show', 'edit', 'update', 'delete'].map(
        (a) => `PostController#${a}`
      )
    );
  });

  it('honours only:', () => {
    const { nodes, references } = extract(
      router('  resources "/posts", PostController, only: [:index, :show]')
    );
    expect(nodes.filter((n) => n.kind === 'route').map((n) => n.name)).toEqual([
      'GET /posts',
      'GET /posts/:id',
    ]);
    expect(handlerRefs(references)).toEqual(['PostController#index', 'PostController#show']);
  });

  it('honours except:', () => {
    const names = extract(router('  resources "/posts", PostController, except: [:delete, :update]'))
      .nodes.filter((n) => n.kind === 'route')
      .map((n) => n.name);
    expect(names).not.toContain('DELETE /posts/:id');
    expect(names).not.toContain('PATCH /posts/:id');
    expect(names).toContain('GET /posts');
    expect(names).toContain('POST /posts');
  });

  it('honours only: in the parenthesised form', () => {
    const { references } = extract(
      router('  resources("/locations", LocationController, only: [:index, :create, :update])')
    );
    expect(handlerRefs(references)).toEqual([
      'LocationController#index',
      'LocationController#create',
      'LocationController#update',
    ]);
  });

  it('expands singular resource into 6 actions (no :index)', () => {
    const { nodes, references } = extract(router('  resource "/profile", ProfileController'));
    expect(nodes.filter((n) => n.kind === 'route').map((n) => n.name)).toEqual([
      'POST /profile',
      'GET /profile/new',
      'GET /profile/:id',
      'GET /profile/:id/edit',
      'PATCH /profile/:id',
      'DELETE /profile/:id',
    ]);
    expect(handlerRefs(references)).toEqual(
      ['create', 'new', 'show', 'edit', 'update', 'delete'].map((a) => `ProfileController#${a}`)
    );
  });

  it('finds only: even when it sits behind other options', () => {
    const { nodes } = extract(
      router('  resources "/services", ServiceController, param: "service_id", only: [:create, :delete]')
    );
    expect(nodes.filter((n) => n.kind === 'route').map((n) => n.name)).toEqual([
      'POST /services',
      'DELETE /services/:id',
    ]);
  });

  it('finds only: spread over continuation lines', () => {
    const { nodes } = extract(
      router(
        [
          '  resources "/products", ProductController,',
          '    param: "odoo_id",',
          '    only: [:index, :create]',
        ].join('\n')
      )
    );
    expect(nodes.filter((n) => n.kind === 'route').map((n) => n.name)).toEqual([
      'GET /products',
      'POST /products',
    ]);
  });

  it('emits nothing for `only: []` even with a nested do block', () => {
    const { nodes } = extract(
      router(
        [
          '  resources "/offers", OfferController, name: "offer", only: [] do',
          '    resources "/services", OfferServiceController, only: [:create]',
          '  end',
        ].join('\n')
      )
    );
    // Only the nested resource contributes a route.
    expect(nodes.filter((n) => n.kind === 'route').map((n) => n.name)).toEqual(['POST /services']);
  });

  it('does not read `resources` as a singular `resource`', () => {
    const names = extract(router('  resources "/posts", PostController'))
      .nodes.filter((n) => n.kind === 'route')
      .map((n) => n.name);
    // 7 plural actions only — no second, singular expansion on top.
    expect(names).toHaveLength(7);
  });

  it('extracts a match/4 catch-all as an ANY route', () => {
    const { nodes, references } = extract(
      router('  match(:*, "/*path", MyAppWeb.ErrorController, :error404)')
    );
    expect(nodes.filter((n) => n.kind === 'route').map((n) => n.name)).toEqual(['ANY /*path']);
    expect(handlerRefs(references)).toEqual(['MyAppWeb.ErrorController#error404']);
  });

  it('extracts match with an explicit verb', () => {
    const names = extract(router('  match :get, "/legacy", LegacyController, :show'))
      .nodes.filter((n) => n.kind === 'route')
      .map((n) => n.name);
    expect(names).toEqual(['GET /legacy']);
  });

  it('extracts forward as a FORWARD route referencing the plug module', () => {
    const { nodes, references } = extract(router('  forward("/service-status", ServiceRouter)'));
    expect(nodes.filter((n) => n.kind === 'route').map((n) => n.name)).toEqual([
      'FORWARD /service-status',
    ]);
    expect(handlerRefs(references)).toEqual(['ServiceRouter']);
  });

  it('extracts a qualified Router.forward call', () => {
    const { references } = extract(router('  Router.forward "/", InformingRoutes'));
    expect(handlerRefs(references)).toEqual(['InformingRoutes']);
  });
});

// ---------------------------------------------------------------------------
// extract — live
// ---------------------------------------------------------------------------

describe('phoenixResolver.extract — live', () => {
  it('emits GET + POST nodes referencing the LiveView module', () => {
    const { nodes, references } = extract(router('  live "/posts/:id", PostLive'));
    expect(nodes.filter((n) => n.kind === 'route').map((n) => n.name)).toEqual([
      'GET /posts/:id',
      'POST /posts/:id',
    ]);
    expect(handlerRefs(references)).toEqual(['PostLive', 'PostLive']);
  });

  it('still references the MODULE when a live_action atom is given', () => {
    // `:index` here is a live_action, not a function — a LiveView has no
    // `def index/2`, so a `PostLive#index` reference could never resolve.
    const { nodes, references } = extract(router('  live "/posts", PostLive, :index'));
    expect(nodes.filter((n) => n.kind === 'route').map((n) => n.name)).toEqual([
      'GET /posts',
      'POST /posts',
    ]);
    expect(handlerRefs(references)).toEqual(['PostLive', 'PostLive']);
  });

  it('does not mistake live_dashboard / live_session for a live route', () => {
    const { nodes } = extract(router('  live_dashboard "/dashboard", metrics: MyAppWeb.Telemetry'));
    expect(nodes.filter((n) => n.kind === 'route')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extract — scopes, pipelines, aliases
// ---------------------------------------------------------------------------

describe('phoenixResolver.extract — scopes and pipelines', () => {
  it('merges nested scope path and module prefixes', () => {
    const { nodes, references } = extract(
      router(
        [
          '  scope "/api", MyApp do',
          '    scope "/v1", ApiV1 do',
          '      get "/users", UserController, :index',
          '    end',
          '  end',
        ].join('\n')
      )
    );
    expect(nodes.filter((n) => n.kind === 'route')[0]!.name).toBe('GET /api/v1/users');
    expect(handlerRefs(references)).toEqual(['MyApp.ApiV1.UserController#index']);
  });

  it('handles a scope with a path but no module alias', () => {
    const { nodes, references } = extract(
      router(['  scope "/locations/v2" do', '    get("/types", LocationController, :types)', '  end'].join('\n'))
    );
    expect(nodes.filter((n) => n.kind === 'route')[0]!.name).toBe('GET /locations/v2/types');
    expect(handlerRefs(references)).toEqual(['LocationController#types']);
  });

  it('normalises scope "/" so the route path stays "/"', () => {
    const { nodes } = extract(
      router(['  scope "/", MyAppWeb do', '    get "/", PageController, :index', '  end'].join('\n'))
    );
    expect(nodes.filter((n) => n.kind === 'route').map((n) => n.name)).toEqual(['GET /']);
  });

  it('emits a pipeline node so pipe_through has a target', () => {
    const { nodes } = extract(
      router(['  pipeline :api do', '    plug :accepts, ["json"]', '  end'].join('\n'))
    );
    const pipeline = nodes.find((n) => n.kind === 'component');
    expect(pipeline).toBeDefined();
    expect(pipeline!.name).toBe(':api');
    expect(pipeline!.qualifiedName).toBe(`${ROUTER}::pipeline:api`);
  });

  it('emits a pipeline node for the parenthesised pipeline(:api) do form', () => {
    const { nodes } = extract(router(['  pipeline(:api) do', '    plug(:accepts, ["json"])', '  end'].join('\n')));
    expect(nodes.find((n) => n.kind === 'component')!.name).toBe(':api');
  });

  it('attaches pipe_through to EVERY route of the scope, not just the first', () => {
    const { nodes, references } = extract(
      router(
        [
          '  scope "/api", MyApp do',
          '    pipe_through [:auth, :api]',
          '    get "/users", UserController, :index',
          '    get "/posts", PostController, :index',
          '  end',
        ].join('\n')
      )
    );
    for (const name of ['GET /api/users', 'GET /api/posts']) {
      const route = nodes.find((n) => n.name === name)!;
      const pipes = references
        .filter((r) => r.fromNodeId === route.id && r.referenceName.startsWith(':'))
        .map((r) => r.referenceName);
      expect(pipes, name).toEqual([':auth', ':api']);
    }
  });

  it('inherits pipe_through into nested scopes without duplicating it', () => {
    const { nodes, references } = extract(
      router(
        [
          '  scope "/api", MyApp do',
          '    pipe_through(:api)',
          '    scope "/v1", V1 do',
          '      get "/users", UserController, :index',
          '    end',
          '  end',
        ].join('\n')
      )
    );
    const route = nodes.find((n) => n.name === 'GET /api/v1/users')!;
    const pipes = references
      .filter((r) => r.fromNodeId === route.id && r.referenceName.startsWith(':'))
      .map((r) => r.referenceName);
    expect(pipes).toEqual([':api']);
  });

  it('treats a capitalised pipe_through entry as a plug module reference', () => {
    const { nodes, references } = extract(
      router(
        [
          '  scope "/", MyAppWeb do',
          '    pipe_through [:app_layout, MyAppWeb.RequireAccountPlug]',
          '    get "/settings", SettingsController, :index',
          '  end',
        ].join('\n')
      )
    );
    const route = nodes.find((n) => n.name === 'GET /settings')!;
    expect(references.filter((r) => r.fromNodeId === route.id).map((r) => r.referenceName)).toEqual([
      'MyAppWeb.SettingsController#index',
      ':app_layout',
      'MyAppWeb.RequireAccountPlug',
    ]);
  });

  it('does not leak a scope pipe_through onto routes outside that scope', () => {
    const { nodes, references } = extract(
      router(
        [
          '  scope "/api" do',
          '    pipe_through :api',
          '    get "/users", UserController, :index',
          '  end',
          '',
          '  get "/health", HealthController, :index',
        ].join('\n')
      )
    );
    const health = nodes.find((n) => n.name === 'GET /health')!;
    expect(references.filter((r) => r.fromNodeId === health.id).map((r) => r.referenceName)).toEqual(
      ['HealthController#index']
    );
  });

  it('does not let a `, do:` one-liner close the scope early', () => {
    const { nodes } = extract(
      router(
        [
          '  scope "/api", MyApp do',
          '    if Mix.env() == :test, do: get("/debug", DebugController, :index)',
          '    get "/users", UserController, :index',
          '  end',
          '',
          '  get "/health", HealthController, :index',
        ].join('\n')
      )
    );
    const names = nodes.filter((n) => n.kind === 'route').map((n) => n.name);
    expect(names).toContain('GET /api/users');
    // /health is OUTSIDE the scope — it must not pick up the /api prefix.
    expect(names).toContain('GET /health');
  });

  it('walks an if/else block inside a scope without losing the scope end', () => {
    const { nodes, references } = extract(
      router(
        [
          '  scope "/" do',
          '    pipe_through :api',
          '',
          '    if Mix.env == :test do',
          '      Router.forward "/_test/", InformingRoutes',
          '    else',
          '      Router.forward "/", InformingRoutes',
          '    end',
          '  end',
        ].join('\n')
      )
    );
    expect(nodes.filter((n) => n.kind === 'route').map((n) => n.name)).toEqual([
      'FORWARD /_test/',
      'FORWARD /',
    ]);
    expect(handlerRefs(references)).toEqual(['InformingRoutes', 'InformingRoutes']);
  });
});

describe('phoenixResolver.extract — alias expansion', () => {
  it('expands a plain `alias A.B.C` shorthand', () => {
    const src = router(
      [
        '  alias Locations.Web.LocationController',
        '',
        '  scope "/v2" do',
        '    get("/types", LocationController, :types)',
        '  end',
      ].join('\n')
    );
    expect(handlerRefs(extract(src).references)).toEqual([
      'Locations.Web.LocationController#types',
    ]);
  });

  it('expands `alias A.B.C, as: D`', () => {
    const src = router(
      [
        '  alias AgreementsWeb.AgreementsInformingController, as: Controller',
        '',
        '  scope "/" do',
        '    get "/rodo.js", Controller, :central_get',
        '  end',
      ].join('\n')
    );
    expect(handlerRefs(extract(src).references)).toEqual([
      'AgreementsWeb.AgreementsInformingController#central_get',
    ]);
  });

  it('expands a grouped `alias A.{B, C}`', () => {
    const src = router(
      [
        '  alias MyAppWeb.{UserController, PostController}',
        '',
        '  get "/users", UserController, :index',
        '  get "/posts", PostController, :index',
      ].join('\n')
    );
    expect(handlerRefs(extract(src).references)).toEqual([
      'MyAppWeb.UserController#index',
      'MyAppWeb.PostController#index',
    ]);
  });

  it('expands an alias used by forward', () => {
    const src = router(
      ['  alias PPController.Status.Router, as: ServiceRouter', '', '  forward("/status", ServiceRouter)'].join('\n')
    );
    expect(handlerRefs(extract(src).references)).toEqual(['PPController.Status.Router']);
  });

  it('lets the enclosing scope alias win over the router alias table', () => {
    // Phoenix concatenates the scope alias verbatim; `alias` does not apply.
    const src = router(
      [
        '  alias Some.Other.UserController',
        '',
        '  scope "/api", MyAppWeb do',
        '    get "/users", UserController, :index',
        '  end',
      ].join('\n')
    );
    expect(handlerRefs(extract(src).references)).toEqual(['MyAppWeb.UserController#index']);
  });
});

// ---------------------------------------------------------------------------
// extract — gating and comment handling
// ---------------------------------------------------------------------------

describe('phoenixResolver.extract — gating', () => {
  it('returns nothing for a non-Elixir file', () => {
    expect(extract('get "/x", X, :index', 'main.ts').nodes).toHaveLength(0);
    expect(extract('get "/x", X, :index', 'config.json').nodes).toHaveLength(0);
  });

  it('ignores an Elixir file that is not a router module', () => {
    const src =
      'defmodule MyAppWeb.UserControllerTest do\n' +
      '  use MyAppWeb.ConnCase\n' +
      '  get "/users", UserController, :index\n' +
      'end\n';
    expect(extract(src, 'test/my_app_web/user_controller_test.exs').nodes).toHaveLength(0);
  });

  it('accepts a router module that is not named router.ex', () => {
    const src =
      'defmodule AgreementsWeb.InformingRoutes do\n' +
      '  use AgreementsWeb, :router\n' +
      '  get "/rodo.js", Controller, :central_get\n' +
      'end\n';
    const { nodes } = extract(src, 'lib/agreements_web/informing_routes.ex');
    expect(nodes.filter((n) => n.kind === 'route').map((n) => n.name)).toEqual(['GET /rodo.js']);
  });

  it('accepts `use Phoenix.Router` directly', () => {
    const src =
      'defmodule MyRouter do\n  use Phoenix.Router\n  get "/x", XController, :index\nend\n';
    expect(extract(src, 'lib/weird/place.ex').nodes.filter((n) => n.kind === 'route')).toHaveLength(1);
  });

  it('skips # commented route lines', () => {
    const { nodes, references } = extract(
      router(['  # get "/fake", FakeController, :index', '  get "/real", RealController, :index'].join('\n'))
    );
    expect(nodes.filter((n) => n.kind === 'route').map((n) => n.name)).toEqual(['GET /real']);
    expect(handlerRefs(references)).toEqual(['RealController#index']);
  });

  it('skips # commented resources', () => {
    const { nodes, references } = extract(
      router(['  # resources "/fake", FakeController', '  resources "/real", RealController'].join('\n'))
    );
    const names = nodes.filter((n) => n.kind === 'route').map((n) => n.name);
    expect(names).toContain('GET /real');
    expect(names).not.toContain('GET /fake');
    expect(handlerRefs(references).every((r) => r.startsWith('RealController#'))).toBe(true);
  });

  it('skips routes shown inside a @moduledoc heredoc', () => {
    const src = router(
      [
        '  @moduledoc """',
        '  Example: get "/fake", FakeController, :index',
        '  """',
        '  get "/real", RealController, :index',
      ].join('\n')
    );
    expect(extract(src).nodes.filter((n) => n.kind === 'route').map((n) => n.name)).toEqual([
      'GET /real',
    ]);
  });
});

describe('stripCommentsForRegex(…, "elixir")', () => {
  it('blanks comments while preserving offsets', () => {
    const src = 'a = 1 # get "/fake", F, :i\nb = 2\n';
    const out = stripCommentsForRegex(src, 'elixir');
    expect(out).toHaveLength(src.length);
    expect(out.split('\n')[1]).toBe('b = 2');
    expect(out).not.toContain('fake');
  });

  it('keeps single-line string literals intact (route paths live in them)', () => {
    const out = stripCommentsForRegex('get "/users/#{id}", C, :show\n', 'elixir');
    expect(out).toContain('"/users/#{id}"');
  });

  it('blanks heredoc bodies', () => {
    const src = '@moduledoc """\nget "/fake", F, :i\n"""\nget "/real", R, :i\n';
    const out = stripCommentsForRegex(src, 'elixir');
    expect(out).not.toContain('fake');
    expect(out).toContain('"/real"');
    expect(out).toHaveLength(src.length);
  });

  it('does not let a ?" character literal swallow the rest of the file', () => {
    const src = 'q = ?"\n# hidden\nget "/real", R, :i\n';
    const out = stripCommentsForRegex(src, 'elixir');
    expect(out).not.toContain('hidden');
    expect(out).toContain('"/real"');
  });
});

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

describe('phoenixResolver.resolve', () => {
  it('resolves Controller#action by exact Elixir qualifiedName', () => {
    const target = fn(
      'Locations.Web.LocationController::sources',
      'apps/locations_web/lib/locations_web/controllers/location_controller.ex'
    );
    const ctx = makeContext([target]);
    const result = phoenixResolver.resolve(routeRef('Locations.Web.LocationController#sources'), ctx);
    expect(result?.targetNodeId).toBe(target.id);
    expect(result?.resolvedBy).toBe('framework');
    expect(result?.confidence).toBe(0.9);
  });

  it('resolves an arity-qualified action node (index/2)', () => {
    const target = fn(
      'MyAppWeb.UserController::index/2',
      'lib/my_app_web/controllers/user_controller.ex',
      'index/2'
    );
    const ctx = makeContext([target]);
    expect(
      phoenixResolver.resolve(routeRef('MyAppWeb.UserController#index'), ctx)?.targetNodeId
    ).toBe(target.id);
  });

  it('resolves an unqualified controller by unique module suffix', () => {
    const target = fn('MyAppWeb.UserController::index', 'lib/my_app_web/controllers/user_controller.ex');
    const ctx = makeContext([target]);
    expect(phoenixResolver.resolve(routeRef('UserController#index'), ctx)?.targetNodeId).toBe(
      target.id
    );
  });

  it('refuses to guess when two umbrella apps hold the same controller name', () => {
    const a = fn('AWeb.UserController::index', 'apps/a_web/lib/a_web/controllers/user_controller.ex');
    const b = fn('BWeb.UserController::index', 'apps/b_web/lib/b_web/controllers/user_controller.ex');
    const ctx = makeContext([a, b]);
    const result = phoenixResolver.resolve(
      routeRef('UserController#index', 'apps/c_web/lib/c_web/router.ex'),
      ctx
    );
    expect(result).toBeNull();
  });

  it('picks the same umbrella app when the module suffix is ambiguous', () => {
    const a = fn('AWeb.UserController::index', 'apps/a_web/lib/a_web/controllers/user_controller.ex');
    const b = fn('BWeb.UserController::index', 'apps/b_web/lib/b_web/controllers/user_controller.ex');
    const ctx = makeContext([a, b]);
    const result = phoenixResolver.resolve(
      routeRef('UserController#index', 'apps/b_web/lib/b_web/router.ex'),
      ctx
    );
    expect(result?.targetNodeId).toBe(b.id);
  });

  it('returns null for a reference with no #action and no matching module', () => {
    expect(phoenixResolver.resolve(routeRef('UserController'), makeContext([]))).toBeNull();
  });

  it('returns null when no controller module is indexed', () => {
    const other = fn('MyAppWeb.PostController::index', 'lib/my_app_web/controllers/post_controller.ex');
    expect(
      phoenixResolver.resolve(routeRef('MyAppWeb.Nonexistent#index'), makeContext([other]))
    ).toBeNull();
  });

  it('resolves a bare live/forward module reference to its namespace node', () => {
    const mod = ns('MyAppWeb.DashboardLive', 'lib/my_app_web/live/dashboard_live.ex');
    const ctx = makeContext([mod]);
    const result = phoenixResolver.resolve(routeRef('MyAppWeb.DashboardLive'), ctx);
    expect(result?.targetNodeId).toBe(mod.id);
  });

  it('falls back to mount/3 when a LiveView module has no namespace node', () => {
    const mount = fn('MyAppWeb.DashboardLive::mount/3', 'lib/my_app_web/live/dashboard_live.ex', 'mount/3');
    const ctx = makeContext([mount]);
    const result = phoenixResolver.resolve(routeRef('MyAppWeb.DashboardLive'), ctx);
    expect(result?.targetNodeId).toBe(mount.id);
    expect(result?.confidence).toBe(0.8);
  });

  it('resolves :pipeline references to the pipeline node in the same file', () => {
    const pipeline = extract(
      router(['  pipeline :api do', '    plug :accepts, ["json"]', '  end'].join('\n'))
    ).nodes.find((n) => n.kind === 'component')!;
    const ctx = makeContext([pipeline]);
    expect(phoenixResolver.resolve(routeRef(':api'), ctx)?.targetNodeId).toBe(pipeline.id);
  });

  it('ignores references from other languages', () => {
    const target = fn('MyAppWeb.UserController::index', 'lib/my_app_web/controllers/user_controller.ex');
    const ref = { ...routeRef('MyAppWeb.UserController#index'), language: 'ruby' as const };
    expect(phoenixResolver.resolve(ref, makeContext([target]))).toBeNull();
  });
});
