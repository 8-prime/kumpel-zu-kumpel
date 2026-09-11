import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PeerSession, type ConnectionStatus } from './peer';
import { createSession, readSession, sessionUrl, type Session } from './session';
import type { TransferFile } from './transfer';
import './style.css';

const statusText: Record<ConnectionStatus, string> = {
  connecting: 'Connecting to the server', waiting: 'Waiting for your peer',
  gathering: 'Finding a direct route', negotiating: 'Connecting your devices',
  verifying: 'Verifying your shared key', connected: 'Connected directly', error: 'Connection interrupted',
};

function readInitial(): { session: Session | null; error?: string } {
  try { return { session: readSession(new URL(location.href)) }; }
  catch (error) { return { session: null, error: (error as Error).message }; }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Icon({ kind, size = 22 }: { kind: 'link' | 'file' | 'lock' | 'copy' | 'arrow' | 'check' | 'upload'; size?: number }) {
  const paths = {
    link: <><path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M13 7l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" /></>,
    file: <><path d="M13 3H5v18h14V9l-6-6Z" /><path d="M13 3v6h6M8 13h8M8 17h5" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M15 8V3H3v13h5" /></>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}

function App() {
  const [initial] = useState(readInitial);
  const [session, setSession] = useState<Session | null>(initial.session);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [error, setError] = useState(initial.error || '');
  const [files, setFiles] = useState<TransferFile[]>([]);
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);
  const peer = useRef<PeerSession | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const objectUrls = useRef(new Set<string>());
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sender = session?.role !== 'receiver';
  const connected = !!session && status === 'connected';
  const shareLink = session ? sessionUrl(location.href, session, 'receiver') : '';

  useEffect(() => {
    if (!session) return;
    let active = true;
    const connection = new PeerSession(session, {
      status: (next, message) => { if (active) { setStatus(next); if (message) setError(message); } },
      file: file => {
        if (!active) { if (file.downloadUrl) URL.revokeObjectURL(file.downloadUrl); return; }
        if (file.downloadUrl) objectUrls.current.add(file.downloadUrl);
        setFiles(current => {
          const index = current.findIndex(item => item.id === file.id);
          return index < 0 ? [...current, file] : current.map(item => item.id === file.id ? file : item);
        });
      },
    });
    peer.current = connection;
    void connection.connect();
    return () => {
      active = false;
      connection.dispose();
      peer.current = null;
      objectUrls.current.forEach(url => URL.revokeObjectURL(url));
      objectUrls.current.clear();
    };
  }, [session]);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  function reset() {
    setSession(null);
    const url = new URL(location.href);
    url.search = ''; url.hash = '';
    history.replaceState(null, '', url);
    setError(''); setFiles([]); setSending(false); setCopied(false);
    setStatus('connecting');
  }

  function generateLink() {
    try {
      if (!window.isSecureContext || !crypto.subtle) throw new Error('Open this page over HTTPS or localhost to create an encrypted transfer.');
      const next = createSession();
      history.replaceState(null, '', sessionUrl(location.href, next));
      setError(''); setSession(next);
    } catch (error) { setError((error as Error).message); }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2500);
    } catch {
      linkInput.current?.focus(); linkInput.current?.select();
      setError('Clipboard access is unavailable. Select and copy the link above.');
    }
  }

  async function sendFiles(selected: File[]) {
    if (!selected.length || sending || !connected || !sender) return;
    const connection = peer.current;
    if (!connection) return;
    setError(''); setSending(true);
    try { await connection.sendFiles(selected); }
    catch (error) { if (peer.current === connection) setError((error as Error).message); }
    finally { if (peer.current === connection) setSending(false); }
  }

  const step = !session ? 0 : connected ? 2 : status === 'waiting' || status === 'connecting' ? 1 : 2;

  return (
    <div className="app-shell">
      <header className="header">
        <a className="wordmark" href="/" onClick={event => { event.preventDefault(); reset(); }} aria-label="Kumpel zu Kumpel home">
          kumpel<span>zu</span>kumpel<span className="brand-period">.</span>
        </a>
        <span className="privacy-label"><Icon kind="lock" size={16} /> Only between you two</span>
      </header>

      <main>
        <div className="intro">
          <h1>{sender ? 'A file. A link. A friend.' : 'You’re on the receiving end.'}</h1>
          <p>{sender ? 'Send files straight to another device, encrypted from end to end.' : 'Keep this page open. Your files will arrive here, already decrypted.'}</p>
        </div>

        <section className="workspace" aria-label="File transfer">
          <aside className="connection-panel">
            <div className="connection-heading"><span>Your connection</span><Icon kind="link" size={20} /></div>
            <div className={`peer-diagram ${connected ? 'is-connected' : ''}`} aria-hidden="true">
              <div className="peer-device you">{sender ? 'S' : 'R'}</div>
              <div className="peer-line"><span /><span /><span /></div>
              <div className="peer-device friend">{sender ? 'R' : 'S'}</div>
            </div>
            <div className="peer-names"><span>You</span><span>{sender ? 'Your friend' : 'The sender'}</span></div>
            <div className="connection-status" role="status" aria-live="polite">
              <span className={`status-light ${connected ? 'online' : status === 'error' && session ? 'offline' : ''}`} />
              {session ? statusText[status] : 'Ready when you are'}
            </div>
            <ol className="steps">
              <li className={session ? 'done' : 'current'}><span>{session ? <Icon kind="check" size={16} /> : '1'}</span><div>{sender ? 'Share your link' : 'Open the share link'}<small>{sender ? 'One link for your receiving peer' : 'Your key stays in this browser'}</small></div></li>
              <li className={connected ? 'done' : step >= 1 ? 'current' : ''}><span>{connected ? <Icon kind="check" size={16} /> : '2'}</span><div>Connect directly<small>Keep both pages open</small></div></li>
              <li className={connected ? 'current' : ''}><span>3</span><div>{sender ? 'Send your files' : 'Save your files'}<small>Encrypted on the way over</small></div></li>
            </ol>
            <div className="privacy-note"><Icon kind="lock" size={20} /><p>Your files and encryption key stay on your devices.</p></div>
          </aside>

          <div className="transfer-panel">
            <div className="panel-heading"><h2>{sender ? 'Send files' : 'Receive files'}</h2>{session && <button className="text-button" onClick={reset}>{connected ? 'End transfer' : 'Start over'}</button>}</div>

            {!session ? <div className="create-link">
              <div className="link-symbol"><Icon kind="link" size={32} /></div>
              <h3>Start with a private link.</h3>
              <p>Share it with the person receiving your files.{' '}<br />Once they join, you can choose what to send.</p>
              <button className="primary-button" onClick={generateLink}>Create share link <Icon kind="arrow" size={20} /></button>
            </div> : sender && !connected ? <div className="share-section">
              <label htmlFor="share-link">Your private share link</label>
              <div className="link-control"><input ref={linkInput} id="share-link" value={shareLink} readOnly onFocus={event => event.target.select()} /><button onClick={copyLink} aria-label={copied ? 'Link copied' : 'Copy share link'}><Icon kind={copied ? 'check' : 'copy'} />{copied ? 'Copied' : 'Copy'}</button></div>
              <p className="link-hint">The link includes the key to your files. Share it only with your receiving peer.</p>
              <div className="waiting-state"><span className={status !== 'error' ? 'waiting-ring' : 'waiting-ring paused'} /><h3>{statusText[status]}</h3><p>{status === 'waiting' ? 'Send them the link, then leave this page open.' : status === 'error' ? 'Start over to create a new connection.' : 'Your files will be ready to send in a moment.'}</p></div>
            </div> : !sender && !connected ? <div className="waiting-state receiver-waiting"><span className={status !== 'error' ? 'waiting-ring' : 'waiting-ring paused'} /><h3>{statusText[status]}</h3><p>{status === 'error' ? 'Ask the sender for a new link.' : 'Keep this page open while your devices connect.'}</p></div> : null}

            {connected && sender && <div className={`drop-zone ${dragging ? 'dragging' : ''} ${sending ? 'busy' : ''}`}
              onDragOver={event => { event.preventDefault(); if (!sending) setDragging(true); }}
              onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); void sendFiles(Array.from(event.dataTransfer.files)); }}>
              <Icon kind="upload" size={32} /><h3>{sending ? 'Sending directly to your peer' : 'Drop your files here'}</h3>
              <p>{sending ? 'Keep this page open until receipt is confirmed.' : 'Choose one file or a handful. Up to 256 MB per link.'}</p>
              <button className="primary-button" disabled={sending} onClick={() => input.current?.click()}>{sending ? 'Transfer in progress' : 'Choose files'}</button>
              <input ref={input} aria-label="Choose files to send" type="file" multiple hidden disabled={sending} onChange={event => { void sendFiles(Array.from(event.target.files || [])); event.target.value = ''; }} />
            </div>}

            {connected && !sender && files.length === 0 && <div className="receive-empty"><Icon kind="file" size={42} /><h3>Ready to receive.</h3><p>The sender can now choose files. They’ll appear here as they arrive.</p></div>}

            {error && <div className="error-message" role="alert">{error}</div>}

            {files.length > 0 && <div className="file-list" aria-label="Transferred files"><div className="file-list-heading"><h3>Your files</h3><span>{files.filter(file => file.status === 'complete').length} of {files.length} complete</span></div>{files.map(file => <div className="file-row" key={file.id}>
              <div className="file-icon"><Icon kind="file" /></div><div className="file-details"><strong title={file.name}>{file.name}</strong><span>{formatBytes(file.size)} · {file.status === 'complete' ? sender ? 'Received by your peer' : 'Decrypted and ready' : file.status === 'failed' ? 'Transfer interrupted' : file.status === 'queued' ? 'Queued' : `${file.status === 'sending' ? 'Sending' : 'Receiving'} ${Math.round(file.bytes / (file.size || 1) * 100)}%`}</span>
              {file.status !== 'complete' && file.status !== 'failed' && <progress aria-label={`Progress for ${file.name}`} value={file.bytes} max={file.size || 1} />}</div>
              {file.downloadUrl ? <a className="download-button" href={file.downloadUrl} download={file.name}>Save<span className="sr-only"> {file.name}</span></a> : file.status === 'complete' ? <span className="complete-icon"><Icon kind="check" /></span> : null}
            </div>)}</div>}

            <div className="transfer-footnote"><Icon kind="lock" size={16} /><span>{connected ? 'Files travel directly between your devices.' : 'No file uploads. No account needed.'}</span></div>
          </div>
        </section>
        <footer><span>From one device to another.</span><span>Keep both pages open until the transfer finishes.</span></footer>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
