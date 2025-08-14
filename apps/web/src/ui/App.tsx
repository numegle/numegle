import React, { useEffect, useMemo, useRef, useState } from 'react';

type Mode = 'text' | 'video';

function randomId(len = 12) {
	const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
	return out;
}

export const App: React.FC = () => {
	const [mode, setMode] = useState<Mode>('text');
	const [interests, setInterests] = useState<string>('');
	const [status, setStatus] = useState<string>('Idle');
	const [sessionId, setSessionId] = useState<string>('');
	const [wsUrl, setWsUrl] = useState<string>('');
	const [iceServers, setIceServers] = useState<any[]>([]);
	const [messages, setMessages] = useState<Array<{ from: string; text: string }>>([]);
	const [isMatched, setIsMatched] = useState(false);
	const [youAreOfferer, setYouAreOfferer] = useState<boolean>(false);
	const localVideoRef = useRef<HTMLVideoElement | null>(null);
	const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
	const pcRef = useRef<RTCPeerConnection | null>(null);
	const localStreamRef = useRef<MediaStream | null>(null);
	const wsRef = useRef<WebSocket | null>(null);
	const [micOn, setMicOn] = useState(true);
	const [camOn, setCamOn] = useState(true);

	useEffect(() => {
		(async () => {
			const apiBase = import.meta.env.VITE_API_URL || `${location.protocol}//${location.hostname}:8787`;
			const res = await fetch(apiBase + '/session/init', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ua: navigator.userAgent })
			});
			const data = await res.json();
			setSessionId(data.sessionId);
			setWsUrl(data.wsUrl);
			setIceServers(Array.isArray(data.iceServers) ? data.iceServers : []);
		})();
	}, []);

	const connect = async () => {
		if (!wsUrl || !sessionId) return;
		if (wsRef.current) wsRef.current.close();
		setStatus('Finding...');
		const url = `${wsUrl}?sid=${encodeURIComponent(sessionId)}`;
		const ws = new WebSocket(url);
		wsRef.current = ws;
		ws.onopen = () => {
			ws.send(JSON.stringify({ t: 'FIND_MATCH', mode, interests: tokensFromInterests() }));
		};
		ws.onmessage = async (e) => {
			const m = JSON.parse(e.data);
			if (m.t === 'SYS') setStatus(m.bannerText);
			if (m.t === 'MATCHED') {
				setStatus("You're now chatting with a random stranger!");
				setIsMatched(true);
				setYouAreOfferer(!!m.youAreOfferer);
				if (mode === 'video') await startVideo(Signaling(ws));
			}
			if (m.t === 'CHAT') setMessages((prev) => [...prev, { from: 'Stranger', text: m.text }]);
			if (m.t === 'TYPING') {
				setPeerTyping(true);
				setTimeout(() => setPeerTyping(false), 1500);
			}
			if (m.t === 'RTC') {
				if (m.type === 'OFFER') {
					await ensurePC(Signaling(ws));
					await ensureLocalMedia();
					attachLocalTracks();
					await pcRef.current!.setRemoteDescription({ type: 'offer', sdp: m.payload.sdp });
					const answer = await pcRef.current!.createAnswer();
					await pcRef.current!.setLocalDescription(answer);
					ws.send(JSON.stringify({ t: 'ANSWER', sdp: answer.sdp }));
				} else if (m.type === 'ANSWER') {
					if (pcRef.current && m.payload.sdp) {
						await pcRef.current.setRemoteDescription({ type: 'answer', sdp: m.payload.sdp });
					}
				} else if (m.type === 'ICE_CANDIDATE' && m.payload.candidate) {
					if (pcRef.current) {
						try { await pcRef.current.addIceCandidate(m.payload.candidate); } catch {}
					}
				}
			}
		};
		ws.onclose = () => setStatus('Disconnected');
		ws.onerror = () => setStatus('Connection error');
	};

	const send = (text: string) => {
		if (!wsRef.current) return;
		wsRef.current.send(JSON.stringify({ t: 'CHAT', text }));
		setMessages((prev) => [...prev, { from: 'You', text }]);
	};

	function Signaling(ws: WebSocket) {
		return {
			sendOffer: (sdp: string) => ws.send(JSON.stringify({ t: 'OFFER', sdp })),
			sendIce: (candidate: RTCIceCandidate) => ws.send(JSON.stringify({ t: 'ICE_CANDIDATE', candidate })),
		};
	}

	async function ensurePC(sig: ReturnType<typeof Signaling>) {
		if (pcRef.current) return pcRef.current;
		const pc = new RTCPeerConnection({ iceServers: iceServers && iceServers.length ? iceServers : [{ urls: ['stun:stun.l.google.com:19302'] }] });
		pc.onicecandidate = (e) => {
			if (e.candidate) sig.sendIce(e.candidate);
		};
		pc.ontrack = (e) => {
			if (remoteVideoRef.current) remoteVideoRef.current.srcObject = e.streams[0];
		};
		pcRef.current = pc;
		return pc;
	}

	async function startVideo(sig: ReturnType<typeof Signaling>) {
		const pc = await ensurePC(sig);
		await ensureLocalMedia();
		attachLocalTracks();
		if (youAreOfferer) {
			const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
			await pc.setLocalDescription(offer);
			sig.sendOffer(offer.sdp || '');
		}
	}

	async function ensureLocalMedia() {
		if (!localStreamRef.current) {
			localStreamRef.current = await navigator.mediaDevices.getUserMedia({
				audio: true,
				video: { width: 640, height: 360, frameRate: { max: 24 } }
			});
			if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
		}
	}

	function attachLocalTracks() {
		const pc = pcRef.current;
		if (!pc || !localStreamRef.current) return;
		const senders = pc.getSenders();
		for (const tr of localStreamRef.current.getTracks()) {
			const kind = tr.kind;
			const sender = senders.find((s) => s.track && s.track.kind === kind);
			if (!sender) pc.addTrack(tr, localStreamRef.current);
		}
	}

	function tokensFromInterests() {
		return interests
			.split(/[\,\s]+/)
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean);
	}

	const [typing, setTyping] = useState(false);
	const typingTimeout = useRef<number | null>(null);
	const [peerTyping, setPeerTyping] = useState(false);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				wsRef.current?.send(JSON.stringify({ t: 'LEAVE' }));
				wsRef.current?.close();
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, []);

	const [input, setInput] = useState('');
	const onSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!input.trim()) return;
		send(input.trim());
		setInput('');
	};

	return (
		<div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', height: '100vh' }}>
			<div style={{ padding: 16, display: 'flex', flexDirection: 'column' }}>
				<div style={{ flex: 1, overflow: 'auto', border: '1px solid #1f2630', borderRadius: 8, padding: 12 }}>
					<div style={{ color: '#7aa2f7', marginBottom: 8 }}>{status}</div>
					{mode === 'video' ? (
						<div style={{ display: 'grid', gridTemplateColumns: '1fr 240px', gap: 12 }}>
							<video ref={remoteVideoRef} autoPlay playsInline style={{ width: '100%', background: '#111827', borderRadius: 8 }} />
							<video ref={localVideoRef} autoPlay muted playsInline style={{ width: '100%', background: '#111827', borderRadius: 8 }} />
						</div>
					) : (
					{messages.map((m, i) => (
						<div key={i} style={{ margin: '6px 0' }}>
							<span style={{ color: m.from === 'You' ? '#a6e3a1' : '#f38ba8' }}>{m.from}:</span>{' '}
							<span style={{ color: '#e6edf3' }}>{m.text}</span>
						</div>
					))}
					)}
				</div>
				{mode === 'text' && (
				<form onSubmit={onSubmit} style={{ display: 'flex', gap: 8, marginTop: 8 }}>
					<input
						type="text"
						placeholder="Type a message and press Enter"
						value={input}
						onChange={(e) => {
							setInput(e.target.value);
							if (wsRef.current) {
								wsRef.current.send(JSON.stringify({ t: 'TYPING' }));
							}
						}}
						style={{ flex: 1, padding: '10px 12px', borderRadius: 8, border: '1px solid #1f2630', background: '#0b0f14', color: '#e6edf3' }}
					/>
					<button type="submit" style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid #1f2630', background: '#111827', color: '#e6edf3' }}>Send</button>
				</form>
				)}
			</div>
			<div style={{ padding: 16, borderLeft: '1px solid #1f2630' }}>
				<h2 style={{ marginTop: 0 }}>Numegle</h2>
				<div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
					<button onClick={() => setMode('text')} aria-pressed={mode==='text'} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #1f2630', background: mode==='text'? '#1f2937':'#111827', color: '#e6edf3' }}>Text</button>
					<button onClick={() => setMode('video')} aria-pressed={mode==='video'} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #1f2630', background: mode==='video'? '#1f2937':'#111827', color: '#e6edf3' }}>Video</button>
				</div>
				<label style={{ display: 'block', fontSize: 12, color: '#9aa4b2', marginBottom: 4 }}>Add interests (comma or space separated)</label>
				<input value={interests} onChange={(e) => setInterests(e.target.value)} placeholder="e.g. music, movies"
					style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #1f2630', background: '#0b0f14', color: '#e6edf3' }} />
				<div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
					<button onClick={connect} style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid #1f2630', background: '#2563eb', color: '#e6edf3' }}>Start</button>
					<button onClick={() => wsRef.current?.send(JSON.stringify({ t: 'NEXT', mode, interests: tokensFromInterests() }))} style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid #1f2630', background: '#111827', color: '#e6edf3' }}>Next</button>
					<button onClick={() => { wsRef.current?.send(JSON.stringify({ t: 'LEAVE' })); wsRef.current?.close(); }} style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid #1f2630', background: '#111827', color: '#e6edf3' }}>Stop (Esc)</button>
					{mode === 'video' && (
						<>
							<button onClick={() => {
								setMicOn((prev) => {
									const next = !prev;
									localStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = next));
									return next;
								});
							}} style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid #1f2630', background: micOn ? '#111827' : '#7f1d1d', color: '#e6edf3' }}>{micOn ? 'Mute' : 'Unmute'}</button>
							<button onClick={() => {
								setCamOn((prev) => {
									const next = !prev;
									localStreamRef.current?.getVideoTracks().forEach((t) => (t.enabled = next));
									return next;
								});
							}} style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid #1f2630', background: camOn ? '#111827' : '#7f1d1d', color: '#e6edf3' }}>{camOn ? 'Camera off' : 'Camera on'}</button>
						</>
					)}
				</div>
				<p style={{ fontSize: 12, color: '#9aa4b2', marginTop: 12 }}>Unmoderated sections are never default and require explicit 18+ acknowledgement.</p>
			</div>
		</div>
	);
};


