import { CdpConnection } from './echotik-sdk/lib/cdp.mjs';
import { BOARD_URL, sleep } from './util.mjs';

export async function connect({ cdp }) {
  return CdpConnection.connectHttp(cdp);
}

export async function attach(connection) {
  const attached = await connection.attachToEchoTikPage();
  await connection.send('Page.enable', {}, attached.sessionId);
  return attached;
}

export async function navigateToBoard(connection, sessionId) {
  await connection.send('Page.navigate', { url: BOARD_URL }, sessionId);
  await sleep(2500);
}

export async function withSession(connection, task) {
  const attached = await attach(connection);
  try {
    return await task(attached.sessionId, attached.target);
  } finally {
    await connection.detach(attached.sessionId);
  }
}
