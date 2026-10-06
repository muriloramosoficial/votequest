// Base BR Code used as the template for every vote. Field 62.05 (the TxID placeholder `***`) is
// replaced with a short per-vote reference code and the CRC16 is recomputed by the Edge Function
// before the QR is served, so the payer and the admin always share a searchable code.
export const DEFAULT_PIX_CONFIG = Object.freeze({
  ready: true,
  pixCode: '00020101021126710014br.gov.bcb.pix0136633fdcad-0185-4292-a6cb-42a9d77aba810209VoteQuest52040000530398654041.005802BR5921OMNIGOVS S COMERCIAIS6006TOLEDO62070503***6304BABD',
  receiverName: 'OMNIGOVS S COMERCIAIS',
  city: 'TOLEDO',
  issue: '',
});
