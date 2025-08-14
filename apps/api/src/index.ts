import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import jwt from '@fastify/jwt';
import { ulid } from 'ulid';

const PORT = Number(process.env.API_PORT || 8787);
const WS_PUBLIC_URL = process.env.WS_PUBLIC_URL || `ws://localhost:${PORT}/ws`;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const TURN_URLS = process.env.TURN_URLS || '';
const TURN_USERNAME = process.env.TURN_USERNAME || '';
const TURN_PASSWORD = process.env.TURN_PASSWORD || '';

type SessionInfo = {
	sessionId: string;
	createdAt: number;
	lastSeenAt: number;
	ws?: any;
};

const sessions = new Map<string, SessionInfo>();

type Mode = 'text' | 'video';
type WaitingUser = {
	sid: string;
	mode: Mode;
	interests: Set<string>;
	enqueuedAt: number;
	ws: any;
};

const waitingByMode: Record<Mode, Set<WaitingUser>> = { text: new Set(), video: new Set() };
const peerOf = new Map<string, string>();
const matchOf = new Map<string, string>(); // sid -> matchId

function tokenizeInterests(tokens: unknown): Set<string> {
	if (!Array.isArray(tokens)) return new Set();
	return new Set(
		tokens
			.map((t) => (typeof t === 'string' ? t : ''))
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean)
	);
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 0;
	let inter = 0;
	for (const x of a) if (b.has(x)) inter++;
	const union = a.size + b.size - inter;
	return union === 0 ? 0 : inter / union;
}

function findBestCandidate(user: WaitingUser, pool: Set<WaitingUser>): WaitingUser | null {
	let best: WaitingUser | null = null;
	let bestScore = -1;
	const ageSec = (Date.now() - user.enqueuedAt) / 1000;
	const threshold = ageSec < 10 ? 0.25 : ageSec < 30 ? 0.1 : 0;
	for (const candidate of pool) {
		if (candidate.sid === user.sid) continue;
		const score = jaccard(user.interests, candidate.interests);
		if (score >= threshold && score > bestScore) {
			best = candidate;
			bestScore = score;
		}
	}
	return best;
}

function linkPeers(a: WaitingUser, b: WaitingUser) {
	const matchId = ulid();
	peerOf.set(a.sid, b.sid);
	peerOf.set(b.sid, a.sid);
	matchOf.set(a.sid, matchId);
	matchOf.set(b.sid, matchId);
	const youOfferFirst = a.sid < b.sid; // deterministic offerer election
	const send = (ws: any, obj: any) => ws.readyState === 1 && ws.send(JSON.stringify(obj));
	send(a.ws, { t: 'MATCHED', matchId, peerId: b.sid, youAreOfferer: youOfferFirst });
	send(b.ws, { t: 'MATCHED', matchId, peerId: a.sid, youAreOfferer: !youOfferFirst });
}

function enqueueOrMatch(sid: string, ws: any, mode: Mode, interestsArr: unknown) {
	const interests = tokenizeInterests(interestsArr);
	const pool = waitingByMode[mode];
	const now = Date.now();
	// Try to find a compatible peer first
	const tempUser: WaitingUser = { sid, mode, interests, enqueuedAt: now, ws };
	const best = findBestCandidate(tempUser, pool);
	if (best) {
		pool.delete(best);
		linkPeers(tempUser, best);
		return;
	}
	// Otherwise enqueue
	pool.add(tempUser);
	const send = (obj: any) => ws.readyState === 1 && ws.send(JSON.stringify(obj));
	send({ t: 'SYS', bannerText: 'Looking for someone you can chat with…' });
}

function leaveMatch(sid: string, reason = 'left') {
	const peer = peerOf.get(sid);
	if (!peer) return;
	peerOf.delete(sid);
	peerOf.delete(peer);
	const matchId = matchOf.get(sid);
	matchOf.delete(sid);
	matchOf.delete(peer);
	const peerInfo = sessions.get(peer);
	if (peerInfo?.ws && peerInfo.ws.readyState === 1) {
		peerInfo.ws.send(JSON.stringify({ t: 'PEER_LEFT', reason, matchId }));
	}
}

async function buildServer() {
	const app = Fastify({ logger: true });
	const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
	await app.register(fastifyCors, {
		credentials: true,
		origin: (origin, cb) => {
			if (!origin) return cb(null, true);
			if (allowedOrigins.length === 0) return cb(null, true);
			if (allowedOrigins.some((o) => origin === o)) return cb(null, true);
			cb(new Error('CORS not allowed'));
		}
	});
	await app.register(fastifyWebsocket);
	await app.register(jwt, { secret: JWT_SECRET });

	app.post('/session/init', async (req, reply) => {
		const sessionId = ulid();
		const now = Date.now();
		sessions.set(sessionId, { sessionId, createdAt: now, lastSeenAt: now });
		const token = app.jwt.sign({ sid: sessionId }, { expiresIn: '10m' });
		const iceServers: any[] = [{ urls: ['stun:stun.l.google.com:19302'] }];
		if (TURN_URLS && TURN_USERNAME && TURN_PASSWORD) {
			const urls = TURN_URLS.split(',').map((s) => s.trim()).filter(Boolean);
			if (urls.length) iceServers.push({ urls, username: TURN_USERNAME, credential: TURN_PASSWORD });
		}
		return reply.send({ sessionId, sessionToken: token, wsUrl: WS_PUBLIC_URL, iceServers });
	});

	app.get('/health', async () => ({ ok: true }));

	app.get('/ws', { websocket: true }, (connection, req) => {
		const { socket } = connection;
		const url = new URL(req.url || '/ws', 'http://localhost');
		const sid = url.searchParams.get('sid') || '';
		if (!sid || !sessions.has(sid)) {
			socket.close();
			return;
		}
		const info = sessions.get(sid)!;
		info.ws = socket as any;
		const send = (obj: any) => socket.readyState === 1 && socket.send(JSON.stringify(obj));

		socket.on('message', (buf: any) => {
			try {
				const raw = typeof buf === 'string' ? buf : buf?.toString?.() ?? '';
				const msg = JSON.parse(raw);
				if (msg.t === 'FIND_MATCH') {
					const mode: Mode = msg.mode === 'video' ? 'video' : 'text';
					enqueueOrMatch(sid, socket, mode, msg.interests);
				}
				else if (msg.t === 'CANCEL_FIND') {
					for (const pool of Object.values(waitingByMode)) {
						for (const w of pool) if (w.sid === sid) pool.delete(w);
					}
				}
				else if (msg.t === 'CHAT') {
					const peer = peerOf.get(sid);
					if (peer) {
						const peerInfo = sessions.get(peer);
						peerInfo?.ws?.send(JSON.stringify({ t: 'CHAT', text: msg.text }));
					}
				}
				else if (msg.t === 'TYPING') {
					const peer = peerOf.get(sid);
					if (peer) sessions.get(peer)?.ws?.send(JSON.stringify({ t: 'TYPING' }));
				}
				else if (msg.t === 'NEXT' || msg.t === 'LEAVE') {
					for (const pool of Object.values(waitingByMode)) {
						for (const w of pool) if (w.sid === sid) pool.delete(w);
					}
					leaveMatch(sid, msg.t === 'NEXT' ? 'next' : 'left');
					// auto requeue on NEXT
					if (msg.t === 'NEXT') {
						const mode: Mode = msg.mode === 'video' ? 'video' : 'text';
						enqueueOrMatch(sid, socket, mode, msg.interests || []);
					}
				}
				else if (msg.t === 'OFFER' || msg.t === 'ANSWER' || msg.t === 'ICE_CANDIDATE') {
					const peer = peerOf.get(sid);
					if (peer) sessions.get(peer)?.ws?.send(JSON.stringify({ t: 'RTC', type: msg.t, payload: { sdp: msg.sdp, candidate: msg.candidate } }));
				}
			} catch (e) {
				app.log.error(e);
			}
		});

		socket.on('close', () => {
			for (const pool of Object.values(waitingByMode)) {
				for (const w of pool) if (w.sid === sid) pool.delete(w);
			}
			leaveMatch(sid, 'disconnect');
		});
	});

	return app;
}

buildServer()
	.then((app) => app.listen({ port: PORT, host: '0.0.0.0' }))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});


