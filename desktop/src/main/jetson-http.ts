import type { SshSession } from './ssh.ts'

// HTTP to the Jetson server for main's own use (spec section 9: device/rig
// channels — "main은 SSH 또는 터널 위의 HTTP로 대행할 뿐이다"). Requests ride
// the pooled SSH session as `curl` against the box's own loopback — the same
// technique provision uses to verify health — so they need no open tunnel and
// no port on the Jetson's network. This module never imports electron.

/** The server answered, but not with 2xx. Carries the status for the caller
 *  (rig:get maps 404 to "no rig", spec section 5's `no-rig`). */
export class JetsonHttpError extends Error {
  constructor(
    readonly status: number,
    body: string
  ) {
    super(`Jetson server answered ${status}${body ? `: ${body.slice(0, 200)}` : ''}`)
    this.name = 'JetsonHttpError'
  }
}

async function request(
  session: SshSession,
  port: number,
  method: 'GET' | 'PUT' | 'POST',
  path: string,
  body?: string
): Promise<unknown> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid server port: ${port}`)
  }
  // The URL ends up on a command line on the box, so the path is restricted
  // to what a path and a query string need, then single-quoted. Callers build
  // paths from typed arguments; this is the backstop, not the only check.
  if (!/^\/[A-Za-z0-9/._~-]*(\?[A-Za-z0-9=&._~%-]*)?$/.test(path)) {
    throw new Error(`refusing unsafe request path: ${path}`)
  }
  // -w appends the status on its own line so one exec returns both; the body
  // (JSON) can itself contain newlines, so split at the LAST one.
  const url = `http://127.0.0.1:${port}${path}`
  const command =
    method === 'GET'
      ? `curl -s -m 25 -o - -w '\\n%{http_code}' '${url}'`
      : `curl -s -m 25 -X ${method} -H 'Content-Type: application/json' --data-binary @- -o - -w '\\n%{http_code}' '${url}'`
  const result = await session.exec(command, body === undefined ? {} : { stdin: body })
  if (result.code !== 0) {
    throw new Error(`curl to ${url} failed (exit ${result.code}): ${result.stderr.trim()}`)
  }
  const cut = result.stdout.lastIndexOf('\n')
  const status = Number(result.stdout.slice(cut + 1).trim())
  const text = cut >= 0 ? result.stdout.slice(0, cut) : ''
  if (!Number.isInteger(status) || status === 0) {
    throw new Error(`no HTTP response from ${url}`)
  }
  if (status < 200 || status >= 300) {
    throw new JetsonHttpError(status, text)
  }
  if (!text.trim()) return null
  return JSON.parse(text)
}

export function jetsonGet(session: SshSession, port: number, path: string): Promise<unknown> {
  return request(session, port, 'GET', path)
}

export function jetsonPost(
  session: SshSession,
  port: number,
  path: string,
  body: unknown
): Promise<unknown> {
  return request(session, port, 'POST', path, JSON.stringify(body))
}

export function jetsonPut(
  session: SshSession,
  port: number,
  path: string,
  body: unknown
): Promise<unknown> {
  return request(session, port, 'PUT', path, JSON.stringify(body))
}
