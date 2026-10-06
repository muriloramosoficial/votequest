import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { apiFetch } from './lib/api.js';

const choices = [
  {
    id: 'lula',
    name: 'Lula',
    party: 'PT',
    partyName: 'Partido dos Trabalhadores',
    tone: 'red',
    number: '01',
  },
  {
    id: 'flavio',
    name: 'Flávio',
    party: 'PL',
    partyName: 'Partido Liberal',
    tone: 'green',
    number: '02',
  },
];

const numberFormat = new Intl.NumberFormat('pt-BR');
const emptyVoteStats = { verifiedCounts: { lula: 0, flavio: 0 } };
const knownVoteStatuses = ['pending', 'review', 'approved', 'rejected', 'expired'];

function Icon({ name, size = 18, className = '' }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    className,
  };

  if (name === 'arrow') return <svg {...common}><path d="M5 12h14M13 5l7 7-7 7" /></svg>;
  if (name === 'pix') {
    return (
      <svg {...common} strokeWidth="1.7">
        <path d="m8.4 4.8 3.6 3.6 3.6-3.6a2.6 2.6 0 0 1 3.7 0l.3.3a2.6 2.6 0 0 1 0 3.7L16 12.4l3.6 3.6a2.6 2.6 0 0 1 0 3.7l-.3.3a2.6 2.6 0 0 1-3.7 0L12 16.4l-3.6 3.6a2.6 2.6 0 0 1-3.7 0l-.3-.3a2.6 2.6 0 0 1 0-3.7L8 12.4 4.4 8.8a2.6 2.6 0 0 1 0-3.7l.3-.3a2.6 2.6 0 0 1 3.7 0Z" />
        <path d="m8 12.4 4-4 4 4-4 4-4-4Z" />
      </svg>
    );
  }
  if (name === 'close') return <svg {...common}><path d="m18 6-12 12M6 6l12 12" /></svg>;
  if (name === 'copy') return <svg {...common}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></svg>;
  if (name === 'check') return <svg {...common}><path d="m5 12 4 4L19 6" /></svg>;
  return null;
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 34 34" fill="none">
        <path d="M17 3.5 29.5 10v14L17 30.5 4.5 24V10L17 3.5Z" stroke="currentColor" strokeWidth="1.6" />
        <path d="m10.5 17.2 4.2 4.2 8.8-9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function formatAmount(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return 'R$ 1,00';
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatCountdown(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function formatMoment(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('pt-BR');
}

function voteStatusMessage(status, choiceName) {
  if (status === 'approved') return `Pagamento aprovado — voto em ${choiceName} validado.`;
  if (status === 'rejected') return 'Pedido não aprovado. O código não foi localizado liquidado no prazo.';
  if (status === 'expired') return 'Este pedido passou do prazo de conferência. Se você pagou, fale com a equipe.';
  if (status === 'review') return 'Na fila: aguardando conferência do pagamento no extrato.';
  return 'Pix gerado. Pague e toque em “Já fiz o Pix”.';
}

// votequest.com.br/<reference code>. Case-insensitive because the receipt is typed from the
// bank's "identificador", which may come back in any case.
const receiptPathPattern = /^\/([23456789A-HJ-NP-Z]{8})$/i;

export default function App() {
  if (typeof window !== 'undefined') {
    const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
    if (pathname === '/admin') return <AdminReviewPage />;
    const receiptMatch = pathname.match(receiptPathPattern);
    if (receiptMatch) return <ReceiptPage code={receiptMatch[1].toUpperCase()} />;
  }
  return <VoteQuestPage />;
}

function VoteQuestPage() {
  const [selected, setSelected] = useState(null);
  const [mobileChoiceIndex, setMobileChoiceIndex] = useState(0);
  const [isMobileLayout, setIsMobileLayout] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches);
  const touchStart = useRef(null);
  const [backendStatus, setBackendStatus] = useState({ checked: false, available: false, databaseReady: false, adminConfigured: false, pixReady: false });
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [voteStats, setVoteStats] = useState(emptyVoteStats);
  const [modalStep, setModalStep] = useState('howto');
  const [intent, setIntent] = useState(null);
  const [intentLoading, setIntentLoading] = useState(false);
  const [intentError, setIntentError] = useState('');
  const [reviewConsent, setReviewConsent] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [submissionError, setSubmissionError] = useState('');
  const [voteProtocol, setVoteProtocol] = useState('');
  const [voteStatus, setVoteStatus] = useState('');
  const [remainingSeconds, setRemainingSeconds] = useState(0);

  const selectedChoice = useMemo(
    () => choices.find((choice) => choice.id === selected) || null,
    [selected],
  );
  const actualTotal = choices.reduce((total, choice) => (
    total + (voteStats.verifiedCounts[choice.id] || 0)
  ), 0);
  const displayCount = (choice) => voteStats.verifiedCounts[choice.id] || 0;
  const displayPercentage = (choice) => (
    actualTotal ? Math.round((displayCount(choice) / actualTotal) * 100) : 0
  );

  const refreshVoteStats = useCallback(async () => {
    try {
      const response = await apiFetch('/api/pix/results', { cache: 'no-store' });
      if (!response.ok) return;
      const payload = await response.json();
      const verified = payload.verifiedCounts || payload.counts || payload;
      setVoteStats({
        verifiedCounts: {
          lula: Number(verified.lula) || 0,
          flavio: Number(verified.flavio) || 0,
        },
      });
    } catch {
      // Keep the last known public counters if the Supabase Edge Function is temporarily unreachable.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/health', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((health) => {
        if (cancelled) return;
        setBackendStatus({
          checked: true,
          available: Boolean(health?.api ?? health?.ok),
          databaseReady: Boolean(health?.databaseReady ?? health?.ok),
          adminConfigured: Boolean(health?.adminConfigured),
          pixReady: Boolean(health?.pixReady),
        });
      })
      .catch(() => {
        if (!cancelled) setBackendStatus({ checked: true, available: false, databaseReady: false, adminConfigured: false, pixReady: false });
      });

    refreshVoteStats();
    const interval = window.setInterval(refreshVoteStats, 12000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [refreshVoteStats]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 760px)');
    const updateLayout = () => setIsMobileLayout(mediaQuery.matches);
    updateLayout();
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', updateLayout);
      return () => mediaQuery.removeEventListener('change', updateLayout);
    }
    mediaQuery.addListener(updateLayout);
    return () => mediaQuery.removeListener(updateLayout);
  }, []);

  useEffect(() => {
    if (!selectedChoice) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') closeModal();
    };
    document.addEventListener('keydown', handleKeyDown);
    document.body.classList.add('modal-open');
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.classList.remove('modal-open');
    };
  }, [selectedChoice]);

  // Each vote gets its own Pix payload with a unique reference code, so a stale QR is never shown.
  const mintIntent = useCallback(async (candidateId) => {
    setIntentLoading(true);
    setIntentError('');
    setIntent(null);
    try {
      const response = await apiFetch('/api/votes/intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidate: candidateId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(response.status === 404
          ? 'A Edge Function votequest-api não está publicada no Supabase. Não é possível gerar o Pix.'
          : body.message || 'Não foi possível gerar o Pix deste voto.');
      }
      if (typeof body.protocol !== 'string' || !body.protocol
        || typeof body.referenceCode !== 'string' || !body.referenceCode
        || typeof body.pixCode !== 'string' || !body.pixCode) {
        throw new Error('A resposta da API é inválida. Confirme se a Edge Function votequest-api está publicada no Supabase.');
      }
      setIntent(body);
      setVoteProtocol(body.protocol);
      setVoteStatus(body.status);
      return body;
    } catch (error) {
      setIntentError(error instanceof TypeError
        ? 'Edge Function votequest-api indisponível. Não pague antes do QR aparecer.'
        : error.message || 'Não foi possível gerar o Pix deste voto.');
      return null;
    } finally {
      setIntentLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!intent?.expiresAt) return undefined;
    const tick = () => {
      setRemainingSeconds(Math.max(0, Math.ceil((new Date(intent.expiresAt).getTime() - Date.now()) / 1000)));
    };
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [intent?.expiresAt]);

  const openModal = (choice) => {
    setSelected(choice.id);
    setCopied(false);
    setCopyError('');
    setModalStep('howto');
    setReviewConsent(false);
    setSubmissionError('');
    setVoteProtocol('');
    setVoteStatus('');
    setRemainingSeconds(0);
  };

  // The Pix is only minted once the voter has read how the reference code works, so opening and
  // abandoning the dialog never leaves a pending request in the database.
  const advanceToPix = async () => {
    if (!selectedChoice) return;
    setModalStep('pix');
    if (!intent) await mintIntent(selectedChoice.id);
  };

  function closeModal() {
    setSelected(null);
    setCopyError('');
  }

  const selectMobileChoice = (index) => {
    setMobileChoiceIndex((index + choices.length) % choices.length);
  };

  const handleTouchStart = (event) => {
    if (!isMobileLayout || event.touches.length !== 1) return;
    const touch = event.touches[0];
    touchStart.current = { x: touch.clientX, y: touch.clientY };
  };

  const handleTouchEnd = (event) => {
    if (!isMobileLayout || !touchStart.current) return;
    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - touchStart.current.x;
    const deltaY = touch.clientY - touchStart.current.y;
    touchStart.current = null;
    if (Math.abs(deltaX) < 48 || Math.abs(deltaX) < Math.abs(deltaY) * 1.25) return;
    selectMobileChoice(mobileChoiceIndex + (deltaX < 0 ? 1 : -1));
  };

  const confirmPayment = async () => {
    if (!voteProtocol || confirming) return;
    setConfirming(true);
    setSubmissionError('');
    try {
      const response = await apiFetch('/api/votes/intent/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocol: voteProtocol }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.message || 'Não foi possível enviar o pedido para conferência.');
      }
      setVoteStatus(body.status);
      setModalStep('submitted');
    } catch (error) {
      setSubmissionError(error instanceof TypeError
        ? 'Edge Function votequest-api indisponível; confira a conexão com o Supabase.'
        : error.message || 'Não foi possível enviar para revisão. Tente novamente.');
    } finally {
      setConfirming(false);
    }
  };

  const checkVoteStatus = async () => {
    if (!voteProtocol) return;
    try {
      const response = await apiFetch(`/api/votes/status/${encodeURIComponent(voteProtocol)}`, { cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !knownVoteStatuses.includes(body.status)) {
        throw new Error(body.message || 'A API de revisão não retornou um status válido.');
      }
      setVoteStatus(body.status);
      if (body.status === 'approved') await refreshVoteStats();
    } catch (error) {
      setSubmissionError(error instanceof TypeError
        ? 'Edge Function votequest-api indisponível; confira a conexão com o Supabase.'
        : error.message || 'Não foi possível consultar agora.');
    }
  };

  const copyPixCode = async () => {
    if (!intent?.pixCode) return;
    try {
      await navigator.clipboard.writeText(intent.pixCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError('Não foi possível copiar automaticamente. Selecione e copie o código Pix.');
    }
  };

  const amountLabel = formatAmount(intent?.amount);
  const expired = Boolean(intent) && remainingSeconds === 0;

  return (
    <div className="votequest-app">
      <main
        className="split-screen"
        aria-label="VoteQuest — enquete com pagamento Pix"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {choices.map((choice, index) => {
          const isActiveMobileChoice = index === mobileChoiceIndex;
          const visibleCount = displayCount(choice);
          const visiblePercentage = displayPercentage(choice);
          return (
          <section
            className={`candidate-panel candidate-panel--${choice.tone} ${isActiveMobileChoice ? 'is-mobile-active' : 'is-mobile-inactive'}`}
            key={choice.id}
            aria-hidden={isMobileLayout && !isActiveMobileChoice}
          >
            <div className="ambient ambient--one" aria-hidden="true" />
            <div className="ambient ambient--two" aria-hidden="true" />
            <div className="panel-watermark" aria-hidden="true">{choice.party}</div>

            <div className="candidate-content">
              <div className={`party-mark party-mark--${choice.tone}`}>
                <span>{choice.party}</span>
                <span className="party-mark__full">{choice.partyName}</span>
              </div>
              <h2 className="candidate-name">{choice.name}</h2>
              <p className="candidate-prompt">A escolha é sua.</p>

              <button className="vote-button" type="button" onClick={() => openModal(choice)}>
                <span>Votar em {choice.name}</span>
                <span className="vote-button__arrow"><Icon name="arrow" size={17} /></span>
              </button>

              <div className="vote-count" aria-label={`${visiblePercentage}% e ${numberFormat.format(visibleCount)} votos validados`}>
                <div className="vote-count__line">
                  <strong className="vote-count__percentage">{visiblePercentage}%</strong>
                  <span className="vote-count__quantity"><strong>{numberFormat.format(visibleCount)}</strong> votos validados</span>
                </div>
                <div className="vote-meter" aria-hidden="true"><i style={{ width: `${visiblePercentage}%` }} /></div>
                <div className="verified-count"><span className="verified-count__dot" /><span>Pagamentos Pix aprovados: <strong>{numberFormat.format(visibleCount)}</strong></span></div>
              </div>
            </div>
            <span className="panel-index" aria-hidden="true">{choice.number} <i /> VoteQuest</span>
          </section>
          );
        })}

        <header className="site-header">
          <a className="brand" href="#top" aria-label="VoteQuest — início">
            <BrandMark />
            <span className="brand-name">Vote<span>Quest</span></span>
          </a>
          <div className="header-pills">
            <span className="status-pill"><i className="status-pill__dot" /> Contagem real</span>
            <span className="price-pill"><Icon name="pix" size={15} /> R$ 1</span>
          </div>
        </header>

        <nav className="mobile-choice-nav" aria-label="Alternar opção da enquete">
          {choices.map((choice, index) => (
            <button
              className={`mobile-choice-tab ${choice.id === choices[mobileChoiceIndex].id ? 'mobile-choice-tab--active' : ''}`}
              key={choice.id}
              type="button"
              aria-pressed={choice.id === choices[mobileChoiceIndex].id}
              onClick={() => selectMobileChoice(index)}
            >
              <span className="mobile-choice-tab__party">{choice.party}</span>
              <span className="mobile-choice-tab__name">{choice.name}</span>
              <span className="mobile-choice-tab__percentage">{displayPercentage(choice)}%</span>
            </button>
          ))}
        </nav>

        <div className="intro-copy" id="top">
          <div className="intro-eyebrow"><span className="intro-eyebrow__spark">✳</span> CONTAGEM REAL · PAGAMENTOS PIX APROVADOS</div>
          <h1>Prove seu voto<span>.</span></h1>
          <p>Doação simbólica de R$ 1,00 via Pix.</p>
          <div className="total-count"><strong>{numberFormat.format(actualTotal)}</strong><span>VOTOS CONTABILIZADOS</span></div>
        </div>

        <div className="versus-badge" aria-hidden="true"><span>OU</span></div>
        <div className="mobile-swipe-hint" aria-hidden="true"><span>↔</span> Deslize para alternar</div>

        <footer className="site-footer">
          CONTAGEM REAL: cada voto gera um Pix com código próprio; só entra no placar o Pix de R$ 1,00 localizado no extrato.
        </footer>
      </main>

      {selectedChoice && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closeModal()}>
          <section className="checkout-modal" role="dialog" aria-modal="true" aria-labelledby="checkout-title">
            <div className="modal-topline">
              <div className="modal-brand">
                <span className="modal-brand-icon"><Icon name="pix" size={17} /></span>
                <span>VOTEQUEST <i>·</i> PIX</span>
              </div>
              <button className="close-button" type="button" onClick={closeModal} aria-label="Fechar">
                <Icon name="close" size={19} />
              </button>
            </div>

            <div className="static-pix-step">
              {modalStep === 'submitted' ? (
                <div className="review-submitted">
                  <span className="modal-eyebrow">PEDIDO ENVIADO</span>
                  <h2 id="checkout-title">Na fila de conferência.</h2>
                  <p className="modal-subtitle">A equipe busca o código abaixo no extrato Pix. O voto só entra na contagem real após aprovação.</p>
                  <div className="protocol-card"><span>CÓDIGO DE REFERÊNCIA</span><code>{intent?.referenceCode}</code></div>
                  <div className="protocol-mini"><span>PROTOCOLO</span><code>{voteProtocol}</code></div>
                  <div className={`review-status review-status--${voteStatus || 'pending'}`}>
                    <span className="review-status__dot" />
                    {voteStatusMessage(voteStatus, selectedChoice.name)}
                  </div>
                  {submissionError && <p className="inline-error" role="status">{submissionError}</p>}
                  <button className="verify-button" type="button" onClick={checkVoteStatus}>Consultar situação</button>
                  <button className="modal-primary modal-primary--muted" type="button" onClick={closeModal}>Voltar à disputa</button>
                </div>
              ) : modalStep === 'review' ? (
                <div className="pix-review-step">
                  <span className="modal-eyebrow">CONFERÊNCIA MANUAL · {amountLabel}</span>
                  <h2 id="checkout-title">Avise que já pagou.</h2>
                  <p className="modal-subtitle">Nada para digitar. A equipe procura o código <strong>{intent?.referenceCode}</strong> no extrato e confere o valor de {amountLabel}.</p>
                  <label className="consent-field">
                    <input type="checkbox" checked={reviewConsent} onChange={(event) => setReviewConsent(event.target.checked)} />
                    <span>Autorizo a conferência deste código de referência junto à minha opção. Após a decisão, a opção sai da fila e o pedido expira sozinho; permanecem apenas os totais agregados.</span>
                  </label>
                  {submissionError && <p className="inline-error form-error" role="alert">{submissionError}</p>}
                  <button className="modal-primary" type="button" onClick={confirmPayment} disabled={!reviewConsent || confirming || expired}>
                    {confirming ? <><span className="mini-spinner mini-spinner--light" /> Enviando…</> : 'Enviar para conferência'}
                  </button>
                  <button className="verify-button" type="button" onClick={() => { setModalStep('pix'); setSubmissionError(''); }}>Voltar ao QR Pix</button>
                </div>
              ) : modalStep === 'howto' ? (
                <div className="howto-step">
                  <span className="modal-eyebrow">ANTES DE PAGAR · LEIA ESTE PASSO</span>
                  <h2 id="checkout-title">Como votar</h2>
                  <p className="modal-subtitle">Todo voto é conferido por um código de referência. Entenda o processo antes de pagar {amountLabel}.</p>

                  <ol className="howto-steps">
                    <li className="howto-item">
                      <span className="howto-item__index">1</span>
                      <div>
                        <strong>O Pix é gerado só para você</strong>
                        <p>Ao continuar, criamos um Pix exclusivo para o seu voto em {selectedChoice.name}, com um <strong>código de referência de 8 caracteres</strong>. Ninguém mais recebe esse mesmo código nem o mesmo QR.</p>
                      </div>
                    </li>
                    <li className="howto-item">
                      <span className="howto-item__index">2</span>
                      <div>
                        <strong>Você paga no seu banco</strong>
                        <p>Aponte a câmera ou copie o código. Confira o recebedor no aplicativo do banco antes de confirmar. O código de referência aparece no comprovante como “identificador”.</p>
                      </div>
                    </li>
                    <li className="howto-item">
                      <span className="howto-item__index">3</span>
                      <div>
                        <strong>Avise que já pagou</strong>
                        <p>Depois do Pix, toque em <strong>“Já fiz o Pix”</strong>. Você não digita nada. A equipe procura o pagamento pelo código no extrato e só então o voto entra na contagem.</p>
                      </div>
                    </li>
                  </ol>

                  <div className="howto-why">
                    <strong>Por que o código é necessário</strong>
                    <p>O banco só informa o valor recebido, não o nome nem a escolha de quem pagou. O código de referência é o único jeito de ligar o Pix recebido ao seu voto — sem ele, a equipe não consegue localizar o pagamento e o voto não pode ser validado.</p>
                  </div>

                  <p className="howto-notes">
                    O pedido vale por 1 hora. Não pedimos CPF, documentos, endereço nem foto do comprovante.
                  </p>

                  <button className="modal-primary" type="button" onClick={advanceToPix}>
                    Entendi — gerar meu Pix de {amountLabel}
                  </button>
                  <button className="verify-button" type="button" onClick={closeModal}>Agora não</button>
                </div>
              ) : (
                <>
                  <span className="modal-eyebrow">PARTICIPAÇÃO · {amountLabel}</span>
                  <h2 id="checkout-title">Sua escolha: {selectedChoice.name}.</h2>
                  <p className="modal-subtitle">Este Pix é gerado só para o seu voto e carrega um código de referência próprio. Confira o recebedor no seu banco antes de pagar.</p>

                  {intent ? (
                    <>
                      <div className="qr-frame">
                        <QRCodeSVG value={intent.pixCode} size={190} level="M" includeMargin />
                      </div>

                      <div className="pix-reference-card">
                        <span>CÓDIGO DE REFERÊNCIA DESTE VOTO</span>
                        <strong>{intent.referenceCode}</strong>
                        <small>Aparece como “identificador” no seu comprovante Pix.</small>
                      </div>

                      <a
                        className="pix-receipt-link"
                        href={`/${String(intent.referenceCode).toLowerCase()}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Acompanhe seu extrato em votequest.com.br/<code>{intent.referenceCode.toLowerCase()}</code> <Icon name="arrow" size={13} />
                      </a>

                      <div className="pix-receiver">
                        <span>RECEBEDOR INFORMADO NO PIX</span>
                        <strong>{intent.receiverName}</strong>
                        <small>{intent.city}</small>
                      </div>

                      <div className="pix-code-heading">
                        <span>PIX COPIA E COLA</span>
                        <span className={`pix-expiry ${expired ? 'pix-expiry--expired' : ''}`}>
                          {expired ? 'Pix expirado' : `Expira em ${formatCountdown(remainingSeconds)}`}
                        </span>
                      </div>
                      <div className="pix-code-box"><code>{intent.pixCode}</code></div>
                      <button className={`copy-button ${copied ? 'copy-button--copied' : ''}`} type="button" onClick={copyPixCode}>
                        <Icon name={copied ? 'check' : 'copy'} size={16} /> {copied ? 'Código copiado' : 'Copiar código Pix'}
                      </button>
                      {copyError && <p className="inline-error" role="status">{copyError}</p>}

                      <div className="static-pix-notice">
                        <strong>Como o pagamento é validado?</strong>
                        <p>Depois do Pix, toque em “Já fiz o Pix”. A equipe localiza o pagamento pelo código <strong>{intent.referenceCode}</strong> no extrato e confere o valor de {amountLabel}. Não coletamos CPF, documentos nem imagens do comprovante.</p>
                      </div>

                      <div className={`backend-status-note ${backendStatus.available && backendStatus.databaseReady && backendStatus.adminConfigured && backendStatus.pixReady ? 'backend-status-note--ready' : 'backend-status-note--warning'}`} role="status">
                        {!backendStatus.checked
                          ? 'Verificando API e banco de dados…'
                          : !backendStatus.available
                            ? 'Edge Function votequest-api do Supabase não respondeu.'
                            : !backendStatus.databaseReady
                              ? 'A Edge Function respondeu, mas o banco ainda não está inicializado ou a migration não foi aplicada. Não pague até concluir a configuração.'
                              : !backendStatus.adminConfigured
                                ? 'Banco conectado, mas falta VOTEQUEST_ADMIN_TOKEN nos secrets das Edge Functions do Supabase. Não pague ainda.'
                                : !backendStatus.pixReady
                                  ? 'VOTEQUEST_PIX_CODE inválido nas secrets do Supabase. Confira recebedor e valor antes de pagar.'
                                  : 'Edge Function e banco Supabase ativos. A conferência é manual.'}
                      </div>

                      <div className="pix-step-actions">
                        <button
                          className="verify-button verify-button--ghost"
                          type="button"
                          onClick={() => setModalStep('howto')}
                        >
                          Como votar
                        </button>
                        <button
                          className="verify-button"
                          type="button"
                          disabled={expired}
                          onClick={() => { setModalStep('review'); setSubmissionError(''); }}
                        >
                          {expired ? 'Prazo encerrado' : 'Já fiz o Pix'}
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="setup-callout" role="status">
                      <span className="setup-callout__icon"><Icon name="pix" size={18} /></span>
                      <div>
                        <strong>{intentLoading ? 'Gerando seu Pix…' : 'Não foi possível gerar o Pix'}</strong>
                        <p>{intentLoading
                          ? 'Cada voto recebe um QR Pix próprio, com código de referência e validade de uma hora.'
                          : intentError}</p>
                      </div>
                      {!intentLoading && selectedChoice && (
                        <button className="verify-button setup-callout__retry" type="button" onClick={() => mintIntent(selectedChoice.id)}>Tentar de novo</button>
                      )}
                    </div>
                  )}
                  <p className="privacy-note">Enquete independente; o placar não é um resultado eleitoral oficial.</p>
                </>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

const receiptStatusCopy = {
  pending: {
    label: 'Aguardando confirmação',
    hint: 'Pagador ainda não tocou em “Já fiz o Pix”. Se você já pagou, registre abaixo; o admin também pode aprovar sem isso.',
  },
  review: {
    label: 'Aguardando conferência',
    hint: 'Pagamento confirmado e agora na fila do administrador, para conferência no extrato.',
  },
  approved: {
    label: 'Pagamento aprovado',
    hint: 'O Pix foi localizado no extrato e este voto já conta no placar.',
  },
  rejected: {
    label: 'Pagamento não localizado',
    hint: 'O código não apareceu liquidado no prazo. Se você pagou, fale com a equipe.',
  },
  expired: {
    label: 'Prazo encerrado',
    hint: 'Este pedido passou da janela de uma hora. Se você pagou, fale com a equipe.',
  },
};

function ReceiptPage({ code }) {
  const [receipt, setReceipt] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const receiptUrl = typeof window !== 'undefined' ? `${window.location.origin}/${code.toLowerCase()}` : `/${code.toLowerCase()}`;

  const loadReceipt = useCallback(async () => {
    try {
      const response = await apiFetch(`/api/votes/receipt/${encodeURIComponent(code)}`, { cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || 'Recibo não encontrado.');
      setReceipt(body);
      setError('');
    } catch (loadError) {
      setReceipt(null);
      setError(loadError.message || 'Não foi possível carregar o recibo.');
    } finally {
      setLoading(false);
    }
  }, [code]);

  useEffect(() => {
    loadReceipt();
  }, [loadReceipt]);

  const confirmPix = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch('/api/votes/intent/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocol: receipt.protocol }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || 'Não foi possível registrar a confirmação.');
      await loadReceipt();
    } catch (confirmError) {
      setError(confirmError.message || 'Não foi possível registrar a confirmação.');
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(receiptUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      setCopied(false);
    }
  };

  const choice = receipt ? choices.find((item) => item.id === receipt.candidate) : null;
  const copy = receipt ? receiptStatusCopy[receipt.status] || receiptStatusCopy.pending : null;

  return (
    <div className="admin-page receipt-page">
      <header className="admin-topbar">
        <a className="brand admin-brand" href="/" aria-label="VoteQuest — início">
          <BrandMark />
          <span className="brand-name">Vote<span>Quest</span></span>
        </a>
        <a className="admin-back-link" href="/">Voltar ao site <Icon name="arrow" size={15} /></a>
      </header>

      <main className="admin-shell">
        <div className="admin-heading">
          <span className="admin-eyebrow">RECIBO VOTEQUEST</span>
          <h1>Recibo do voto</h1>
          <p>Guarde ou compartilhe este link. Ele mostra o status do pagamento pelo código que aparece no seu comprovante Pix — nenhum dado seu.</p>
        </div>

        <section className="admin-card">
          {loading && <p className="receipt-loading">Carregando recibo…</p>}

          {!loading && error && !receipt && (
            <div className="receipt-missing">
              <p className="inline-error" role="alert">{error}</p>
              <a className="verify-button" href="/">Voltar ao início</a>
            </div>
          )}

          {!loading && receipt && (
            <div className="receipt-body">
              <div className="receipt-head">
                <code className="receipt-code">{receipt.referenceCode}</code>
                <span className={`receipt-status receipt-status--${receipt.status}`}>{copy.label}</span>
              </div>

              <div className="receipt-choice">
                {choice ? (
                  <>
                    <span className={`admin-option admin-option--${choice.tone}`}>{choice.party} · {choice.partyName}</span>
                    <strong className={`receipt-choice__name receipt-choice__name--${choice.tone}`}>{choice.name}</strong>
                  </>
                ) : (
                  <span className="receipt-choice__name receipt-choice__name--unknown">Opção não associada</span>
                )}
              </div>

              <p className="receipt-hint">{copy.hint}</p>

              <dl className="admin-timeline receipt-timeline">
                <div><dt>Pedido criado</dt><dd>{formatMoment(receipt.requestedAt)}</dd></div>
                {receipt.confirmedAt && <div><dt>“Já fiz o Pix”</dt><dd>{formatMoment(receipt.confirmedAt)}</dd></div>}
                <div><dt>Prazo</dt><dd>{formatMoment(receipt.expiresAt)}</dd></div>
                {receipt.decidedAt && <div><dt>Decidido em</dt><dd>{formatMoment(receipt.decidedAt)}</dd></div>}
              </dl>

              <p className="receipt-link-line">Este recibo: <code>{receiptUrl}</code></p>

              {error && <p className="inline-error" role="alert">{error}</p>}

              <div className="receipt-actions">
                <button type="button" className="verify-button" onClick={copyLink}>
                  <Icon name={copied ? 'check' : 'copy'} size={15} />
                  {copied ? 'Link copiado' : 'Copiar link do recibo'}
                </button>
                {receipt.status === 'pending' && receipt.protocol && (
                  <button type="button" className="receipt-confirm" onClick={confirmPix} disabled={busy}>
                    {busy ? 'Registrando…' : 'Já fiz o Pix'}
                  </button>
                )}
              </div>

              <p className="receipt-note">Este link não contém CPF, nome ou dados bancários: só o código aleatório, a opção escolhida e o status. O token administrativo nunca aparece aqui.</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function AdminReviewPage() {
  const [tokenInput, setTokenInput] = useState('');
  const [adminToken, setAdminToken] = useState('');
  const [pending, setPending] = useState(null);
  const [verifiedCounts, setVerifiedCounts] = useState({ lula: 0, flavio: 0 });
  const [loading, setLoading] = useState(false);
  const [busyProtocol, setBusyProtocol] = useState('');
  const [error, setError] = useState('');

  const loadQueue = async (token = tokenInput) => {
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const response = await apiFetch('/api/admin/votes', { headers: { 'x-admin-token': token }, cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(body.pending)) {
        throw new Error(body.message || 'A API administrativa do Supabase não respondeu corretamente; confirme a Edge Function e a migration.');
      }
      setAdminToken(token);
      setPending(body.pending);
      setVerifiedCounts({
        lula: Number(body.verifiedCounts?.lula) || 0,
        flavio: Number(body.verifiedCounts?.flavio) || 0,
      });
    } catch (loadError) {
      setPending(null);
      setError(loadError.message || 'Não foi possível autenticar.');
    } finally {
      setLoading(false);
    }
  };

  const decideVote = async (protocol, decision) => {
    setBusyProtocol(protocol);
    setError('');
    try {
      const response = await apiFetch(`/api/admin/votes/${encodeURIComponent(protocol)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify({ decision }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !['approved', 'rejected'].includes(body.status)) {
        throw new Error(body.message || 'A API de revisão não confirmou a decisão.');
      }
      await loadQueue(adminToken);
    } catch (actionError) {
      setError(actionError.message || 'Não foi possível salvar a decisão.');
    } finally {
      setBusyProtocol('');
    }
  };

  const signOut = () => {
    setTokenInput('');
    setAdminToken('');
    setPending(null);
    setError('');
  };

  return (
    <div className="admin-page">
      <header className="admin-topbar">
        <a className="brand admin-brand" href="/" aria-label="VoteQuest — início">
          <BrandMark />
          <span className="brand-name">Vote<span>Quest</span></span>
        </a>
        <a className="admin-back-link" href="/">Voltar ao site <Icon name="arrow" size={15} /></a>
      </header>
      <main className="admin-shell">
        <div className="admin-heading">
          <span className="admin-eyebrow">ÁREA RESTRITA</span>
          <h1>Revisão de pagamentos Pix</h1>
          <p>Busque o código de referência no extrato. Aprove somente Pix liquidados de R$ 1,00 anteriores ao prazo do pedido.</p>
        </div>

        <section className="admin-card">
          {pending === null ? (
            <form className="admin-login" onSubmit={(event) => { event.preventDefault(); loadQueue(tokenInput); }}>
              <label className="field field--wide">
                <span>Token administrativo</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={tokenInput}
                  onChange={(event) => setTokenInput(event.target.value)}
                  required
                  placeholder="Configurado no servidor como VOTEQUEST_ADMIN_TOKEN"
                />
              </label>
              {error && <p className="inline-error" role="alert">{error}</p>}
              <button className="modal-primary" type="submit" disabled={loading}>
                {loading ? <><span className="mini-spinner mini-spinner--light" /> Validando…</> : 'Abrir fila de revisão'}
              </button>
            </form>
          ) : (
            <>
              <section className="admin-tools" aria-label="Resumo da contagem">
                <div className="approved-totals">
                  <span>Pagamentos Pix aprovados</span>
                  <strong>PT {numberFormat.format(verifiedCounts.lula || 0)}</strong>
                  <i />
                  <strong>PL {numberFormat.format(verifiedCounts.flavio || 0)}</strong>
                </div>
              </section>

              <div className="admin-queue-heading">
                <div>
                  <span className="admin-eyebrow">PENDENTES</span>
                  <h2>{pending.length} {pending.length === 1 ? 'pedido' : 'pedidos'}</h2>
                </div>
                <button className="admin-logout" type="button" onClick={signOut}>Sair</button>
              </div>
              {error && <p className="inline-error" role="alert">{error}</p>}
              {pending.length === 0 ? (
                <div className="admin-empty"><span>✓</span><strong>Fila em dia</strong><p>Novos pedidos de conferência aparecerão aqui.</p></div>
              ) : (
                <div className="admin-queue">
                  {pending.map((item) => {
                    const choice = choices.find((candidate) => candidate.id === item.candidate);
                    const awaitingReview = item.status === 'review';
                    return (
                      <article className="admin-request" key={item.protocol}>
                        <div className="admin-request__top">
                          <span className={`admin-option admin-option--${choice?.tone || 'red'}`}>
                            {choice?.party || item.candidate} · {choice?.name || 'Opção'}
                          </span>
                          <span className={`admin-await ${awaitingReview ? 'admin-await--ready' : ''}`}>
                            {awaitingReview ? 'Aguardando conferência' : 'Pagador ainda não confirmou'}
                          </span>
                        </div>

                        <div className="admin-reference">
                          <span>CÓDIGO DE REFERÊNCIA (TxID NO PIX)</span>
                          <code>{item.referenceCode}</code>
                          <a className="admin-receipt-link" href={`/${String(item.referenceCode).toLowerCase()}`}>
                            Recibo do pagador <Icon name="arrow" size={13} />
                          </a>
                        </div>

                        <dl className="admin-timeline">
                          <div><dt>Pedido criado</dt><dd>{formatMoment(item.requestedAt)}</dd></div>
                          <div><dt>“Já fiz o Pix”</dt><dd>{formatMoment(item.confirmedAt)}</dd></div>
                          <div><dt>Expira em</dt><dd>{formatMoment(item.expiresAt)}</dd></div>
                        </dl>

                        <p>No extrato, busque pelo código <strong>{item.referenceCode}</strong>: valor R$ 1,00, recebedor e status liquidado.</p>

                        <div className="admin-actions">
                          <button type="button" className="admin-reject" onClick={() => decideVote(item.protocol, 'reject')} disabled={busyProtocol === item.protocol}>Rejeitar</button>
                          <button type="button" className="admin-approve" onClick={() => decideVote(item.protocol, 'approve')} disabled={busyProtocol === item.protocol}>
                            {busyProtocol === item.protocol ? 'Salvando…' : 'Pagamento confirmado'}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </section>
        <p className="admin-data-note">Cada voto tem um código de referência aleatório, sem vínculo com CPF ou documento — e cada código vira um recibo público em <strong>votequest.com.br/seucodigo</strong>, que o pagador pode abrir para conferir o status. A fila guarda a opção até a decisão e expira pedidos após uma hora. Aprove ou rejeite inclusive pedidos que o pagador ainda não confirmou: quem paga e fecha a tela pode confirmar depois pelo recibo. O token fica somente na memória desta página.</p>
      </main>
    </div>
  );
}