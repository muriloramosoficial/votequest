import { useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';

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

const emptyPixConfig = { ready: false, pixCode: '', receiverName: '', city: '', issue: 'missing' };

export default function App() {
  const [selected, setSelected] = useState(null);
  const [pixConfig, setPixConfig] = useState(emptyPixConfig);
  const [pixConfigLoaded, setPixConfigLoaded] = useState(false);
  const pixCode = pixConfig.pixCode;
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');

  const selectedChoice = useMemo(
    () => choices.find((choice) => choice.id === selected) || null,
    [selected],
  );

  useEffect(() => {
    fetch('/api/pix/config', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((config) => setPixConfig(config || emptyPixConfig))
      .catch(() => setPixConfig(emptyPixConfig))
      .finally(() => setPixConfigLoaded(true));
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
  };

  function closeModal() {
    setSelected(null);
    setCopyError('');
  }

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
      <main className="split-screen" aria-label="VoteQuest — demonstração de enquete">
        {choices.map((choice) => (
          <section className={`candidate-panel candidate-panel--${choice.tone}`} key={choice.id}>
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

              <div className="vote-count" aria-label={`${choice.percentage}% e ${numberFormat.format(choice.count)} votos simulados`}>
                <div className="vote-count__line">
                  <strong className="vote-count__percentage">{choice.percentage}%</strong>
                  <span className="vote-count__quantity"><strong>{numberFormat.format(choice.count)}</strong> votos simulados</span>
                </div>
                <div className="vote-meter" aria-hidden="true"><i style={{ width: `${choice.percentage}%` }} /></div>
              </div>
            </div>
            <span className="panel-index" aria-hidden="true">{choice.number} <i /> VoteQuest</span>
          </section>
        ))}

        <header className="site-header">
          <a className="brand" href="#top" aria-label="VoteQuest — início">
            <BrandMark />
            <span className="brand-name">Vote<span>Quest</span></span>
          </a>
          <div className="header-pills">
            <span className="status-pill status-pill--demo"><i className="status-pill__dot" /> Dados simulados</span>
            <span className="price-pill"><Icon name="pix" size={15} /> R$ 10</span>
          </div>
        </header>

        <div className="intro-copy" id="top">
          <div className="intro-eyebrow"><span className="intro-eyebrow__spark">✳</span> MODO DEMONSTRAÇÃO · NÃO SÃO VOTOS REAIS</div>
          <h1>Prove seu voto<span>.</span></h1>
          <p>Doação simbólica de R$ 10,00 via Pix.</p>
          <div className="demo-total"><strong>700.000</strong><span>VOTOS ILUSTRATIVOS</span></div>
        </div>

        <div className="versus-badge" aria-hidden="true"><span>OU</span></div>

        <footer className="site-footer">
          PLACAR DEMONSTRATIVO: total e percentuais simulados, sem relação com votos ou pesquisa reais. O Pix não é validado automaticamente.
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
                        : 'Configure o código Pix copia e cola de R$ 10,00 no servidor para habilitar o pagamento.'}</p>
                  </div>
                </div>
              )}

              <div className="static-pix-notice">
                <strong>Importante</strong>
                <p>Nenhum CPF é solicitado nem enviado ao Telegram. O pagamento não é confirmado automaticamente; este placar permanece apenas demonstrativo.</p>
              </div>
              <button className="modal-primary modal-primary--muted" type="button" onClick={closeModal}>Voltar à disputa</button>
              <p className="privacy-note">Enquete independente, sem vínculo oficial com partidos ou candidaturas.</p>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
