import type { Env } from "./types";

export interface RouteMatch {
  handler: RouteHandler;
  params: Record<string, string>;
}

export type RouteHandler = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params: Record<string, string>,
) => Promise<Response>;

interface RouteEntry {
  method: string;
  pattern: string;
  handler: RouteHandler;
}

const routes: RouteEntry[] = [];

export function addRoute(method: string, pattern: string, handler: RouteHandler): void {
  routes.push({ method, pattern, handler });
}

export function matchRoute(method: string, pathname: string): RouteMatch | null {
  for (const route of routes) {
    if (route.method !== method && route.method !== "*") continue;
    const params = matchPattern(route.pattern, pathname);
    if (params !== null) return { handler: route.handler, params };
  }
  return null;
}

function matchPattern(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];
    const path = pathParts[i];
    if (pp.startsWith(":")) {
      params[pp.slice(1)] = decodeURIComponent(path);
    } else if (pp !== path) {
      return null;
    }
  }
  return params;
}
