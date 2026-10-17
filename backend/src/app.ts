import http from 'node:http';
import { Router,Reply } from './http/router.js';
import { isReady } from './services/readiness.js';
import { authenticateRequest } from './middleware/auth.js';
import { registerAuth } from './controllers/authController.js';
import { registerUsers } from './controllers/userController.js';
import { registerServers } from './controllers/serverController.js';
import { registerMessages } from './controllers/messageController.js';
import { registerVoice } from './controllers/voiceController.js';
import { registerAdmin } from './controllers/adminController.js';
import { Gateway } from './websocket/gateway.js';

export interface App {
  server: http.Server;
  gateway: Gateway;
}

/** Builds the HTTP server + WebSocket gateway. Routes are reachable both with and without the /api prefix. */
export function createApp(): App {
  const router = new Router(authenticateRequest);
  router.get('/ready',{auth:'none'},async()=>{const ok=await isReady();return new Reply(ok?200:503,{ok});});
  registerAuth(router);
  registerUsers(router);
  registerServers(router);
  registerMessages(router);
  registerVoice(router);
  registerAdmin(router);

  const server = http.createServer((req, res) => {
    let url:URL;
    try {url=new URL(req.url ?? '/', 'http://localhost');}
    catch {
      res.writeHead(400,{'Connection':'close','Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'})
        .end(JSON.stringify({error:{code:'BAD_REQUEST',message:'Некорректный адрес запроса'}}));
      return;
    }
    const path = url.pathname.startsWith('/api/') ? url.pathname.slice(4) : url.pathname;
    void router.handle(req, res, path, url.searchParams);
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 5 * 60_000; // large uploads on slow links
  server.keepAliveTimeout = 65_000;

  const gateway = new Gateway(server);
  return { server, gateway };
}
