import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { apiFetch } from './lib/api.js';
import { DEFAULT_PIX_CONFIG } from '../supabase/functions/_shared/pix-config.js';

const choices = [
  {
    id: 'lula',
    name: 'Lula',
    party: 'PT',
    partyName: 'Partido dos Trabalhadores',
    tone: 'red',
    number: '01',
    count: 434000,
    percentage: 62,
  },
  {
    id: 'flavio',
    name: 'Flávio',
    party: 'PL',
    partyName: 'Partido Liberal',
    tone: 'green',
    number: '02',
    count: 266000,
    percentage: 38,
  },
];

const numberFormat = new Intl.NumberFormat('pt-BR');

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

const FALLBACK_PIX_CONFIG = DEFAULT_PIX_CONFIG;
const emptyPixConfig = { ready: false, pixCode: '', receiverName: '', city: '', issue: 'missing' };
const emptyVoteStats = { demoMode: true, verifiedCounts: { lula: 0, flavio: 0 }, manualCounts: { lula: 0, flavio: 0 } };

export default function App() {
  if (typeof window !== 'undefined' && window.location.pathname === '/admin') {
    return <AdminReviewPage />;
  }
  return <VoteQuestPage />;
}

function VoteQuestPage() {
  const [selected, setSelected] = useState(null);
  const [mobileChoiceIndex, setMobileChoiceIndex] = useState(0);
  const [isMobileLayout, setIsMobileLayout] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches);
  const touchStart = useRef(null);
  const [pixConfig, setPixConfig] = useState(FALLBACK_PIX_CONFIG);
  const [pixConfigLoaded, setPixConfigLoaded] = useState(false);
  const pixCode = pixConfig.pixCode;
  const [backendStatus, setBackendStatus] = useState({ checked: false, available: false, databaseReady: false, adminConfigured: false, pixReady: false });
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [voteStats, setVoteStats] = useState(emptyVoteStats);
  const [modalStep, setModalStep] = useState('pix');
  const [endToEndId, setEndToEndId] = useState('');
  const [reviewConsent, setReviewConsent] = useState(false);
  const [submittingVote, setSubmittingVote] = useState(false);
  const [submissionError, setSubmissionError] = useState('');
  const [voteProtocol, setVoteProtocol] = useState('');
  const [voteStatus, setVoteStatus] = useState('');

  const selectedChoice = useMemo(
    () => choices.find((choice) => choice.id === selected) || null,
    [selected],
  );
  const actualTotal = choices.reduce((total, choice) => (
    total + (voteStats.verifiedCounts[choice.id] || 0) + (voteStats.manualCounts[choice.id] || 0)
  ), 0);
  const displayCount = (choice) => voteStats.demoMode
    ? choice.count
    : (voteStats.verifiedCounts[choice.id] || 0) + (voteStats.manualCounts[choice.id] || 0);
  const displayPercentage = (choice) => {
    if (voteStats.demoMode) return choice.percentage;
    return actualTotal ? Math.round((displayCount(choice) / actualTotal) * 100) : 0;
  };

  const refreshVoteStats = useCallback(async () => {
    try {
      const response = await apiFetch('/api/pix/results', { cache: 'no-store' });
      if (!response.ok) return;
      const payload = await response.json();
      const verified = payload.verifiedCounts || payload.counts || payload;
      setVoteStats({
        demoMode: payload.demoMode !== false,
        verifiedCounts: { lula: Number(verified.lula) || 0, flavio: Number(verified.flavio) || 0 },
        manualCounts: {
          lula: Number(payload.manualCounts?.lula) || 0,
          flavio: Number(payload.manualCounts?.flavio) || 0,
        },
      });
    } catch {
      // Keep the last known public counters if the Supabase Edge Function is temporarily unreachable.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/pix/config', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((config) => {
        if (cancelled) return;
        if (config?.ready) setPixConfig(config);
        else if (config?.issue === 'invalid') setPixConfig({ ...FALLBACK_PIX_CONFIG, issue: 'invalid-env' });
        else setPixConfig(FALLBACK_PIX_CONFIG);
      })
      .catch(() => { if (!cancelled) setPixConfig(FALLBACK_PIX_CONFIG); })
      .finally(() => { if (!cancelled) setPixConfigLoaded(true); });

    apiFetch('/api/health', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((health) => {
        if (!cancelled) setBackendStatus({
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

  const openModal = (choice) => {
    setSelected(choice.id);
    setCopied(false);
    setCopyError('');
    setModalStep('pix');
    setEndToEndId('');
    setReviewConsent(false);
    setSubmissionError('');
    setVoteProtocol('');
    setVoteStatus('');
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

  const submitVoteForReview = async (event) => {
    event.preventDefault();
    if (!selectedChoice || !reviewConsent || submittingVote) return;
    if (!backendStatus.available || !backendStatus.databaseReady || !backendStatus.adminConfigured) {
      setSubmissionError('A Edge Function do Supabase, o banco e o token administrativo precisam estar configurados antes de enviar votos.');
      return;
    }
    setSubmittingVote(true);
    setSubmissionError('');
    try {
      const response = await apiFetch('/api/votes/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidate: selectedChoice.id, endToEndId: endToEndId.trim() }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const serverMessage = response.status === 404
          ? 'A Edge Function votequest-api não está publicada no Supabase. O QR pode aparecer, mas o envio do voto exige essa função.'
          : body.message || 'Não foi possível enviar o pedido.';
        throw new Error(serverMessage);
      }
      if (body.status !== 'pending' || typeof body.protocol !== 'string' || !body.protocol) {
        throw new Error('A resposta da API de revisão é inválida. Confirme se a Edge Function votequest-api está publicada no Supabase.');
      }
      setVoteProtocol(body.protocol);
      setVoteStatus('pending');
      setModalStep('submitted');
    } catch (error) {
      setSubmissionError(error instanceof TypeError
        ? 'Edge Function votequest-api indisponível. Publique a função no Supabase e confirme sua URL e chave anon públicas.'
        : error.message || 'Não foi possível enviar para revisão. Tente novamente.');
    } finally {
      setSubmittingVote(false);
    }
  };

  const checkVoteStatus = async () => {
    if (!voteProtocol) return;
    try {
      const response = await apiFetch(`/api/votes/status/${encodeURIComponent(voteProtocol)}`, { cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !['pending', 'approved', 'rejected'].includes(body.status)) {
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
    if (!pixCode) return;
    try {
      await navigator.clipboard.writeText(pixCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError('Não foi possível copiar automaticamente. Selecione e copie o código Pix.');
    }
  };

  return (
    <div className="votequest-app">
      <main
        className="split-screen"
        aria-label="VoteQuest — demonstração de enquete"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {choices.map((choice, index) => {
          const isActiveMobileChoice = index === mobileChoiceIndex;
          const verifiedCount = voteStats.verifiedCounts[choice.id] || 0;
          const manualCount = voteStats.manualCounts[choice.id] || 0;
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

              <div className="vote-count" aria-label={`${visiblePercentage}% e ${numberFormat.format(visibleCount)} ${voteStats.demoMode ? 'votos simulados' : 'votos contabilizados'}`}>
                <div className="vote-count__line">
                  <strong className="vote-count__percentage">{visiblePercentage}%</strong>
                  <span className="vote-count__quantity"><strong>{numberFormat.format(visibleCount)}</strong> {voteStats.demoMode ? 'votos simulados' : 'votos contabilizados'}</span>
                </div>
                <div className="vote-meter" aria-hidden="true"><i style={{ width: `${visiblePercentage}%` }} /></div>
                <div className="verified-count"><span className="verified-count__dot" /><span>Pix aprovados: <strong>{numberFormat.format(verifiedCount)}</strong></span><span>·</span><span>manuais: <strong>{numberFormat.format(manualCount)}</strong></span></div>
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
            <span className="status-pill status-pill--demo"><i className="status-pill__dot" /> {voteStats.demoMode ? 'Dados simulados' : 'Contagem real'}</span>
            <span className="price-pill"><Icon name="pix" size={15} /> R$ 10</span>
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
          <div className="intro-eyebrow"><span className="intro-eyebrow__spark">✳</span> {voteStats.demoMode ? 'MODO DEMONSTRAÇÃO · NÃO SÃO VOTOS REAIS' : 'CONTAGEM REAL · COM AJUSTES ADMIN IDENTIFICADOS'}</div>
          <h1>Prove seu voto<span>.</span></h1>
          <p>Doação simbólica de R$ 10,00 via Pix.</p>
          <div className="demo-total"><strong>{numberFormat.format(voteStats.demoMode ? 700000 : actualTotal)}</strong><span>{voteStats.demoMode ? 'VOTOS ILUSTRATIVOS' : 'VOTOS CONTABILIZADOS'}</span></div>
        </div>

        <div className="versus-badge" aria-hidden="true"><span>OU</span></div>
        <div className="mobile-swipe-hint" aria-hidden="true"><span>↔</span> Deslize para alternar</div>

        <footer className="site-footer">
          {voteStats.demoMode
            ? 'PLACAR DEMONSTRATIVO: total e percentuais simulados, sem relação com votos ou pesquisa reais.'
            : 'CONTAGEM REAL: pagamentos aprovados + inclusões manuais identificadas. Pix estático exige conferência manual.'}
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
                  <span className="modal-eyebrow">PROTOCOLO DE REVISÃO</span>
                  <h2 id="checkout-title">Pedido enviado.</h2>
                  <p className="modal-subtitle">A equipe precisa conferir manualmente o E2E ID no extrato Pix. O voto só entra na contagem real após aprovação.</p>
                  <div className="protocol-card"><span>SEU PROTOCOLO</span><code>{voteProtocol}</code></div>
                  <div className={`review-status review-status--${voteStatus || 'pending'}`}>
                    <span className="review-status__dot" />
                    {voteStatus === 'approved' ? `Pagamento aprovado — voto em ${selectedChoice.name} validado.`
                      : voteStatus === 'rejected' ? 'Pedido não aprovado. Confira o E2E ID com seu comprovante.'
                        : 'Aguardando conferência do pagamento.'}
                  </div>
                  {submissionError && <p className="inline-error" role="status">{submissionError}</p>}
                  <button className="verify-button" type="button" onClick={checkVoteStatus}>Consultar situação</button>
                  <button className="modal-primary modal-primary--muted" type="button" onClick={closeModal}>Voltar à disputa</button>
                </div>
              ) : modalStep === 'review' ? (
                <div className="pix-review-step">
                  <span className="modal-eyebrow">CONFERÊNCIA MANUAL · R$ 10,00</span>
                  <h2 id="checkout-title">Informe o E2E ID.</h2>
                  <p className="modal-subtitle">Encontre o identificador End-to-End no comprovante do seu banco. Não envie CPF nem imagem do comprovante.</p>
                  <form className="review-form" onSubmit={submitVoteForReview}>
                    <label className="field field--wide">
                      <span>Identificador E2E da transação Pix</span>
                      <input
                        type="text"
                        name="endToEndId"
                        required
                        minLength={16}
                        maxLength={100}
                        autoComplete="off"
                        autoCapitalize="characters"
                        spellCheck="false"
                        value={endToEndId}
                        onChange={(event) => setEndToEndId(event.target.value.replace(/\s/g, '').toUpperCase())}
                        placeholder="Ex.: E123… (conforme seu comprovante)"
                      />
                    </label>
                    <label className="consent-field">
                      <input type="checkbox" required checked={reviewConsent} onChange={(event) => setReviewConsent(event.target.checked)} />
                      <span>Autorizo a conferência temporária deste identificador junto à minha opção. Após a decisão, o E2E ID e a opção saem da fila; apenas totais agregados são mantidos.</span>
                    </label>
                    {submissionError && <p className="inline-error form-error" role="alert">{submissionError}</p>}
                    <button className="modal-primary" type="submit" disabled={!reviewConsent || submittingVote || !backendStatus.available || !backendStatus.databaseReady || !backendStatus.adminConfigured}>
                      {submittingVote ? <><span className="mini-spinner mini-spinner--light" /> Enviando…</> : 'Enviar para conferência'}
                    </button>
                  </form>
                  <button className="verify-button" type="button" onClick={() => { setModalStep('pix'); setSubmissionError(''); }}>Voltar ao QR Pix</button>
                </div>
              ) : (
                <>
                  <span className="modal-eyebrow">PARTICIPAÇÃO · R$ 10,00</span>
                  <h2 id="checkout-title">Sua escolha: {selectedChoice.name}.</h2>
                  <p className="modal-subtitle">O Pix é estático. Confira o recebedor no seu banco antes de pagar.</p>

                  {pixCode ? (
                    <>
                      <div className="qr-frame">
                        <QRCodeSVG value={pixCode} size={190} level="M" includeMargin />
                      </div>
                      <div className="pix-receiver">
                        <span>RECEBEDOR INFORMADO NO PIX</span>
                        <strong>{pixConfig.receiverName}</strong>
                        <small>{pixConfig.city}</small>
                      </div>
                      <div className="pix-code-heading"><span>PIX COPIA E COLA</span><span className="pix-expiry">Valor da doação: R$ 10,00</span></div>
                      <div className="pix-code-box"><code>{pixCode}</code></div>
                      <button className={`copy-button ${copied ? 'copy-button--copied' : ''}`} type="button" onClick={copyPixCode}>
                        <Icon name={copied ? 'check' : 'copy'} size={16} /> {copied ? 'Código copiado' : 'Copiar código Pix'}
                      </button>
                      {copyError && <p className="inline-error" role="status">{copyError}</p>}
                      <div className="static-pix-notice">
                        <strong>Como o pagamento é validado?</strong>
                        <p>Depois do Pix, informe o E2E ID do comprovante. A equipe confere o valor de R$ 10,00 no extrato e aprova ou rejeita manualmente. Nenhum CPF é solicitado ou enviado ao Telegram.</p>
                      </div>
                      <div className={`backend-status-note ${backendStatus.available && backendStatus.databaseReady && backendStatus.adminConfigured && backendStatus.pixReady ? 'backend-status-note--ready' : 'backend-status-note--warning'}`} role="status">
                        {!backendStatus.checked
                          ? 'Verificando API e banco de dados…'
                          : !backendStatus.available
                            ? 'Edge Function votequest-api do Supabase não respondeu. Publique a função e confira a URL/chave anon do projeto.'
                            : !backendStatus.databaseReady
                              ? 'A Edge Function respondeu, mas o banco ainda não está inicializado ou a migration não foi aplicada. Não pague até concluir a configuração.'
                              : !backendStatus.adminConfigured
                                ? 'Banco conectado, mas falta VOTEQUEST_ADMIN_TOKEN nos secrets das Edge Functions do Supabase. Não pague ainda.'
                                : !backendStatus.pixReady
                                  ? 'VOTEQUEST_PIX_CODE inválido nas secrets do Supabase. Está sendo mostrado o QR oficial de contingência; confira recebedor e valor antes de pagar.'
                                  : 'Edge Function e banco Supabase ativos. O E2E ID será conferido manualmente.'}
                      </div>
                      <button
                        className="verify-button"
                        type="button"
                        disabled={!backendStatus.checked || !backendStatus.available || !backendStatus.databaseReady || !backendStatus.adminConfigured}
                        onClick={() => { setModalStep('review'); setSubmissionError(''); }}
                      >
                        {!backendStatus.checked ? 'Verificando servidor…'
                          : !backendStatus.available ? 'API Supabase indisponível'
                            : !backendStatus.databaseReady ? 'Banco Supabase não configurado'
                              : !backendStatus.adminConfigured ? 'Revisão não configurada'
                                : 'Já fiz o Pix — enviar para conferência'}
                      </button>
                    </>
                  ) : (
                    <div className="setup-callout" role="status">
                      <span className="setup-callout__icon"><Icon name="pix" size={18} /></span>
                      <div>
                        <strong>{!pixConfigLoaded ? 'Carregando configuração Pix…' : pixConfig.issue === 'invalid' ? 'QR Pix não validado' : 'Aguardando novo QR Pix'}</strong>
                        <p>{!pixConfigLoaded
                          ? 'Verificando se há um QR estático configurado.'
                          : pixConfig.issue === 'invalid'
                            ? 'O código configurado não passou nas validações de valor, tipo estático ou CRC. Confira o copia e cola antes de publicar.'
                            : 'Configure VOTEQUEST_PIX_CODE nas secrets da Edge Function do Supabase para habilitar o pagamento.'}</p>
                      </div>
                    </div>
                  )}
                  <p className="privacy-note">Enquete independente; o placar demonstrativo não é um resultado real.</p>
                </>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function AdminReviewPage() {
  const [tokenInput, setTokenInput] = useState('');
  const [adminToken, setAdminToken] = useState('');
  const [pending, setPending] = useState(null);
  const [demoMode, setDemoMode] = useState(true);
  const [manualCounts, setManualCounts] = useState({ lula: 0, flavio: 0 });
  const [recentManualAdjustments, setRecentManualAdjustments] = useState([]);
  const [manualForm, setManualForm] = useState({ candidate: 'lula', amount: '1', reason: '' });
  const [loading, setLoading] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingManual, setSavingManual] = useState(false);
  const [busyProtocol, setBusyProtocol] = useState('');
  const [manualFeedback, setManualFeedback] = useState('');
  const [error, setError] = useState('');

  const loadQueue = async (token = tokenInput) => {
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const response = await apiFetch('/api/admin/votes', { headers: { 'x-admin-token': token }, cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(body.pending) || typeof body.demoMode !== 'boolean') {
        throw new Error(body.message || 'A API administrativa do Supabase não respondeu corretamente; confirme a Edge Function e a migration.');
      }
      setAdminToken(token);
      setPending(Array.isArray(body.pending) ? body.pending : []);
      setDemoMode(body.demoMode !== false);
      setManualCounts({ lula: Number(body.manualCounts?.lula) || 0, flavio: Number(body.manualCounts?.flavio) || 0 });
      setRecentManualAdjustments(Array.isArray(body.recentManualAdjustments) ? body.recentManualAdjustments : []);
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

  const updateDemoMode = async (event) => {
    const nextDemoMode = event.target.checked;
    setSavingSettings(true);
    setError('');
    try {
      const response = await apiFetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify({ demoMode: nextDemoMode }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || typeof body.demoMode !== 'boolean') {
        throw new Error(body.message || 'A API administrativa não confirmou o modo do placar.');
      }
      setDemoMode(body.demoMode);
    } catch (settingError) {
      setError(settingError.message || 'Não foi possível atualizar o modo.');
    } finally {
      setSavingSettings(false);
    }
  };

  const addManualVotes = async (event) => {
    event.preventDefault();
    setSavingManual(true);
    setManualFeedback('');
    setError('');
    try {
      const response = await apiFetch('/api/admin/manual-votes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify({
          candidate: manualForm.candidate,
          amount: Number(manualForm.amount),
          reason: manualForm.reason.trim(),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.adjustment || !body.manualCounts) {
        throw new Error(body.message || 'A API administrativa não confirmou a inclusão manual.');
      }
      setManualCounts(body.manualCounts);
      setRecentManualAdjustments((current) => [body.adjustment, ...current].slice(0, 20));
      setManualFeedback(`${numberFormat.format(body.adjustment.amount)} votos adicionados a ${choices.find((choice) => choice.id === body.adjustment.candidate)?.name || body.adjustment.candidate}.`);
      setManualForm((current) => ({ ...current, amount: '1', reason: '' }));
    } catch (manualError) {
      setError(manualError.message || 'Não foi possível adicionar os votos.');
    } finally {
      setSavingManual(false);
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
          <p>Confira o E2E ID no extrato da conta. Aprove somente transferências recebidas de R$ 10,00.</p>
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
              <section className="admin-tools" aria-label="Controles do placar">
                <div className="demo-control">
                  <div>
                    <span className="admin-eyebrow">MODO DO PLACAR</span>
                    <h3>{demoMode ? 'Demonstração ativada' : 'Contagem real ativada'}</h3>
                    <p>{demoMode
                      ? 'O público vê os números simulados; pagamentos aprovados e inclusões manuais ficam separados.'
                      : 'O público vê votos aprovados + inclusões manuais, com a origem discriminada.'}</p>
                  </div>
                  <label className={`admin-toggle ${savingSettings ? 'admin-toggle--disabled' : ''}`}>
                    <span className="sr-only">Ativar modo demonstrativo</span>
                    <input type="checkbox" checked={demoMode} onChange={updateDemoMode} disabled={savingSettings} />
                    <i aria-hidden="true" />
                  </label>
                </div>

                <form className="manual-votes-form" onSubmit={addManualVotes}>
                  <div className="manual-votes-form__heading">
                    <div>
                      <span className="admin-eyebrow">AJUSTE AUDITÁVEL</span>
                      <h3>Adicionar votos manualmente</h3>
                    </div>
                    <p>Os votos manuais aparecem separados dos pagamentos aprovados.</p>
                  </div>
                  <div className="manual-votes-form__fields">
                    <label className="field">
                      <span>Candidato</span>
                      <select value={manualForm.candidate} onChange={(event) => setManualForm({ ...manualForm, candidate: event.target.value })}>
                        <option value="lula">PT · Lula</option>
                        <option value="flavio">PL · Flávio</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>Quantidade</span>
                      <input type="number" min="1" max="1000000" step="1" required value={manualForm.amount} onChange={(event) => setManualForm({ ...manualForm, amount: event.target.value })} />
                    </label>
                    <label className="field field--wide">
                      <span>Motivo para auditoria</span>
                      <input type="text" minLength="3" maxLength="160" required value={manualForm.reason} onChange={(event) => setManualForm({ ...manualForm, reason: event.target.value })} placeholder="Ex.: correção de lote conferido" />
                    </label>
                    <button className="modal-primary" type="submit" disabled={savingManual}>
                      {savingManual ? 'Salvando…' : 'Adicionar ao total manual'}
                    </button>
                  </div>
                  {manualFeedback && <p className="manual-feedback" role="status">{manualFeedback}</p>}
                </form>

                <div className="manual-totals">
                  <span>Manuais acumulados</span>
                  <strong>PT {numberFormat.format(manualCounts.lula || 0)}</strong>
                  <i />
                  <strong>PL {numberFormat.format(manualCounts.flavio || 0)}</strong>
                </div>
                {recentManualAdjustments.length > 0 && (
                  <div className="manual-audit-list">
                    <h4>Últimas inclusões</h4>
                    {recentManualAdjustments.slice(0, 5).map((item) => {
                      const choice = choices.find((candidate) => candidate.id === item.candidate);
                      return <p key={item.id}><span>{numberFormat.format(item.amount)} · {choice?.party} {choice?.name}</span><small>{item.reason}</small></p>;
                    })}
                  </div>
                )}
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
                    return (
                      <article className="admin-request" key={item.protocol}>
                        <div className="admin-request__top">
                          <span className={`admin-option admin-option--${choice?.tone || 'red'}`}>
                            {choice?.party || item.candidate} · {choice?.name || 'Opção'}
                          </span>
                          <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('pt-BR')}</time>
                        </div>
                        <div className="admin-reference"><span>PROTOCOLO {item.protocol}</span><code>{item.endToEndId}</code></div>
                        <p>Confira no extrato: valor R$ 10,00, recebedor e status liquidado.</p>
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
        <p className="admin-data-note">A fila guarda temporariamente a opção e o E2E ID para conferência. Ao aprovar/rejeitar, esses dados são removidos; permanecem apenas o placar agregado, um hash antirreuso e o status do protocolo. O token fica somente na memória desta página.</p>
      </main>
    </div>
  );
}
