/**
 * REST client. The access token lives only in memory; the refresh token is an httpOnly cookie.
 * On 401 the client refreshes once (deduplicated across concurrent requests) and retries.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

const BASE = '/api';
let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let sessionGeneration=0;
const listeners = new Set<(token: string | null) => void>();

export function setAccessToken(token: string | null): void {
  ++sessionGeneration;
  refreshing=null;
  updateAccessToken(token);
}
function updateAccessToken(token:string|null):void {
  accessToken = token;
  listeners.forEach((l) => l(token));
}
export function getAccessToken(): string | null {
  return accessToken;
}
export function onTokenChange(fn: (token: string | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let onSessionLost: () => void = () => undefined;
export function setSessionLostHandler(fn: () => void): void {
  onSessionLost = fn;
}

/** Exchanges the refresh cookie for a new access token. Returns false if the session is gone. */
export function refreshSession(): Promise<boolean> {
  if(refreshing)return refreshing;
  const generation=sessionGeneration;
  const pending = (async () => {
    try {
      for(let attempt=0;attempt<3;attempt++){
      if(generation!==sessionGeneration)return accessToken!==null;
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'concord' },
      });
      if(generation!==sessionGeneration)return accessToken!==null;
      if (!res.ok) {
        if(res.status===401){updateAccessToken(null);return false;}
        if(res.status===409 && attempt<2){await new Promise(r=>setTimeout(r,100));continue;}
        throw await parseError(res);
      }
      const body = (await res.json()) as { accessToken: string };
      if(generation!==sessionGeneration)return accessToken!==null;
      updateAccessToken(body.accessToken);
      return true;
      }
      throw new ApiError(409,'REFRESH_RETRY','Обновление сессии ещё выполняется');
    } catch(err) {
      // A failed network, busy server or rate limit must not log out a valid session.
      throw err instanceof ApiError?err:new ApiError(0,'NETWORK','Нет соединения с сервером');
    } finally {
      setTimeout(() => {if(refreshing===pending)refreshing=null;}, 0);
    }
  })();
  refreshing=pending;
  return pending;
}

async function parseError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: { code: string; message: string; details?: unknown } };
    if (body.error) return new ApiError(res.status, body.error.code, body.error.message, body.error.details);
  } catch {
    /* not json */
  }
  return new ApiError(res.status, 'HTTP_' + res.status, res.status >= 500 ? 'Сервер недоступен, попробуйте позже' : 'Ошибка запроса');
}

export async function request<T>(method: string, path: string, body?: unknown, init: { raw?: Blob | ArrayBuffer; headers?: Record<string, string> } = {}): Promise<T> {
  const generation=sessionGeneration;
  const checkSession=()=>{if(generation!==sessionGeneration)throw new ApiError(401,'SESSION_CHANGED','Аккаунт изменён, повторите действие');};
  const doFetch = (): Promise<Response> => {
    const headers: Record<string, string> = { 'X-Requested-With': 'concord', ...init.headers };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    let payload: BodyInit | undefined;
    if (init.raw) payload = init.raw;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    return fetch(BASE + path, { method, headers, body: payload, credentials: 'same-origin' }).catch(()=>{
      throw new ApiError(0,'NETWORK','Нет соединения с сервером');
    });
  };
  let res: Response;
  try {
    res = await doFetch();
  } catch {
    throw new ApiError(0, 'NETWORK', 'Нет соединения с сервером');
  }
  checkSession();
  if (res.status === 401 && !path.startsWith('/auth/')) {
    const refreshed=await refreshSession();
    checkSession();
    if (refreshed) res = await doFetch();
    else {
      onSessionLost();
      throw await parseError(res);
    }
  }
  checkSession();
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  const result=(await res.json()) as T;
  checkSession();
  return result;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b: unknown = {}) => request<T>('POST', p, b),
  patch: <T>(p: string, b: unknown) => request<T>('PATCH', p, b),
  put: <T>(p: string, b?: unknown) => request<T>('PUT', p, b),
  del: <T>(p: string) => request<T>('DELETE', p),
  putFile: <T>(p: string, file: Blob) => request<T>('PUT', p, undefined, { raw: file }),
};

export interface UploadHandle<T> {
  promise: Promise<T>;
  abort(): void;
}

/** Uploads a raw file with progress events (fetch has no upload progress, XHR does). */
export function uploadWithProgress<T>(path: string, file: File, onProgress: (fraction: number) => void): UploadHandle<T> {
  const xhr = new XMLHttpRequest();
  const generation=sessionGeneration;
  let settled=false,cancelled=false;
  let rejectUpload:(error:ApiError)=>void=()=>undefined;
  const promise = new Promise<T>((resolve, reject) => {
    const fail=(err:unknown)=>{if(!settled){settled=true;reject(err);}};
    rejectUpload=fail;
    const send = (retry: boolean): void => {
      if(cancelled||settled)return;
      if(generation!==sessionGeneration){fail(new ApiError(401,'SESSION_CHANGED','Аккаунт изменён, повторите загрузку'));return;}
      xhr.open('POST', BASE + path);
      xhr.setRequestHeader('X-Requested-With', 'concord');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
      if (accessToken) xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = async () => {
        if(cancelled||settled)return;
        const sessionChanged=()=>{
          if(generation===sessionGeneration)return false;
          fail(new ApiError(401,'SESSION_CHANGED','Аккаунт изменён, повторите загрузку'));
          return true;
        };
        if(sessionChanged())return;
        try{
          if(xhr.status===401&&retry){
            const refreshed=await refreshSession();
            if(cancelled||settled)return;
            if(sessionChanged())return;
            if(refreshed)return send(false);
            onSessionLost();
          }
        }catch(err){fail(err);return;}
        let body: any = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* ignore */
        }
        if (xhr.status >= 200 && xhr.status < 300) {settled=true;resolve(body as T);}
        else fail(new ApiError(xhr.status, body?.error?.code ?? 'UPLOAD', body?.error?.message ?? 'Не удалось загрузить файл'));
      };
      xhr.onerror = () => fail(new ApiError(0, 'NETWORK', 'Соединение прервано во время загрузки'));
      xhr.onabort = () => fail(new ApiError(0, 'ABORTED', 'Загрузка отменена'));
      xhr.send(file);
    };
    send(true);
  });
  return { promise, abort: () => {
    if(settled)return;
    cancelled=true;
    rejectUpload(new ApiError(0,'ABORTED','Загрузка отменена'));
    xhr.abort();
  } };
}

export function errorMessage(err: unknown, fallback = 'Что-то пошло не так'): string {
  if (err instanceof ApiError) return err.message;
  return fallback;
}
