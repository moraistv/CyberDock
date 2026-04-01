// useLabels.js
import { useApi } from './useApi';

/**
 * Composable para baixar etiquetas (PDF/ZPL) de forma robusta.
 * - Mais permissivo no status local (bloqueia somente casos claramente impossíveis)
 * - Verifica disponibilidade/estado no backend (que renova o token automaticamente)
 * - Suporte a múltiplos shipments em lote por seller
 */
export function useLabels() {
  const api = useApi();

  // Status que DEFINITIVAMENTE não imprimem
  const STATUS_NOT_PRINTABLE = ['shipped', 'delivered', 'cancelled', 'canceled'];

  // Status que geralmente permitem (lista aberta, porém o backend faz a checagem final)
  const STATUS_TENDS_TO_OK = [
    'paid', 
    'ready_to_ship', 
    'handling', 
    'ready_to_print', 
    'to_be_agreed', 
    'invoice_pending',
    'pending', // Adicionado: status pendente
    'confirmed', // Adicionado: status confirmado
    'processing', // Adicionado: status processando
    'preparing', // Adicionado: status preparando
    'packed', // Adicionado: status embalado
    'ready', // Adicionado: status pronto
    'waiting', // Adicionado: status aguardando
    'in_progress', // Adicionado: status em progresso
    'active', // Adicionado: status ativo
    'open' // Adicionado: status aberto
  ];

  /**
   * Extrai dados necessários e decide se vale tentar imprimir (otimista).
   * Se houver sellerId + shipmentId e status NÃO estiver em "não-imprime", deixamos tentar.
   */
  function getLabelInfo(sale) {
    const raw = sale?.raw_api_data || {};
    const status = (raw?.status ?? sale?.sale_status ?? '').toLowerCase();
    const sellerId = sale?.seller_id ?? raw?.seller?.id ?? raw?.seller_id;
    const shipmentIdRaw = raw?.shipping?.id ?? raw?.shipment_id ?? sale?.shipment_id;

    // normaliza shipment id (remove .0 se vier de XLS/planilha)
    const shipmentId = shipmentIdRaw ? String(shipmentIdRaw).split('.')[0] : null;

    if (!sellerId || !shipmentId) {
      return {
        canPrint: false,
        shipmentId: null,
        sellerId: null,
        status: status || 'unknown',
        reason: !sellerId ? 'ID do vendedor não encontrado' : 'ID de envio não encontrado',
      };
    }

    if (status && STATUS_NOT_PRINTABLE.includes(status)) {
      const mapReason = {
        shipped: 'Pedido já enviado',
        delivered: 'Pedido já entregue',
        cancelled: 'Pedido cancelado',
        canceled: 'Pedido cancelado',
      };
      return {
        canPrint: false,
        shipmentId: null,
        sellerId: null,
        status,
        reason: mapReason[status] || `Status "${status}" não permite impressão`,
      };
    }

    // Fora os bloqueios definitivos, vamos deixar tentar (o backend decide)
    // Se o status está na lista de tendência OK ou se é desconhecido/vazio, permite tentar
    const isKnownGoodStatus = STATUS_TENDS_TO_OK.includes(status);
    const isUnknownStatus = !status || status === 'unknown' || status === '';
    
    let reason;
    if (isKnownGoodStatus) {
      reason = 'Etiqueta possivelmente disponível';
    } else if (isUnknownStatus) {
      reason = 'Status desconhecido - tentando verificar na API';
    } else {
      reason = `Status "${status}" não está na lista de bloqueios - tentando verificar na API`;
    }

    return {
      canPrint: true,
      shipmentId,
      sellerId,
      status: status || 'unknown',
      reason,
    };
  }

  /**
   * Verifica disponibilidade perguntando ao backend (que consulta o ML).
   * Se não conseguir checar, não bloqueia o usuário — deixa tentar baixar.
   */
  async function checkLabelAvailability(shipmentId, sellerId) {
    if (!shipmentId || !sellerId) {
      return { available: false, reason: 'Parâmetros inválidos' };
    }
    try {
      const { data } = await api.get(`/ml/check-shipment-status?shipment_id=${shipmentId}&seller_id=${sellerId}`);
      const status = (data?.status || '').toLowerCase();
      if (STATUS_NOT_PRINTABLE.includes(status)) {
        return { available: false, reason: `Status '${status}' não permite impressão de etiqueta` };
      }
      return { available: true };
    } catch (err) {
      // Se der erro na checagem, não bloqueia — o download tentará mesmo assim.
      console.warn('checkLabelAvailability falhou, permitindo tentativa de download:', err?.message || err);
      return { available: true };
    }
  }

  /**
   * Baixa UMA etiqueta (pdf|zpl). Usa stream do backend (responseType 'blob').
   */
  async function downloadLabel(shipmentId, sellerId, type = 'pdf') {
    if (!shipmentId || !sellerId) {
      const msg = 'ID de Envio e ID do Vendedor são obrigatórios.';
      console.error(msg);
      throw new Error(msg);
    }

    const url = `/ml/download-label?shipment_ids=${encodeURIComponent(String(shipmentId).split('.')[0])}&response_type=${type}&seller_id=${sellerId}`;

    try {
      const blob = await api.get(url, { responseType: 'blob' }); // axios retorna Blob no browser
      // Se por alguma razão voltar JSON, lemos pra exibir o erro amigável
      if (blob && blob.type === 'application/json') {
        const text = await blob.text();
        try {
          const j = JSON.parse(text);
          throw new Error(j.message || j.error || 'Erro ao obter etiqueta.');
        } catch {
          throw new Error(text || 'Erro desconhecido ao obter etiqueta.');
        }
      }

      if (!(blob instanceof Blob)) {
        throw new Error('Resposta inválida do servidor. Não foi possível criar o arquivo para download.');
      }

      const fileURL = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = fileURL;
      a.setAttribute('download', `etiqueta-${shipmentId}.${type}`);
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(fileURL);
    } catch (err) {
      // Se axios estiver configurado pra lançar em 4xx/5xx, podemos ter err.response.data (Blob)
      const dataBlob = err?.response?.data;
      if (dataBlob instanceof Blob && dataBlob.type === 'application/json') {
        const text = await dataBlob.text();
        try {
          const j = JSON.parse(text);
          throw new Error(j.message || j.error || 'Erro ao obter etiqueta.');
        } catch {
          throw new Error(text || 'Erro ao obter etiqueta.');
        }
      }
      throw err;
    }
  }

  /**
   * Baixa etiquetas EM LOTE (por vendedor) — agrupa shipments do mesmo seller
   * e chama 1 vez por grupo (endpoint aceita CSV de IDs).
   * @param {Array<{seller_id:number, raw_api_data?:object, shipment_id?:string|number}>} sales
   * @param {'pdf'|'zpl'|'zpl2'} type
   */
  async function downloadLabelsForSales(sales, type = 'pdf') {
    if (!Array.isArray(sales) || sales.length === 0) {
      throw new Error('Nenhuma venda informada.');
    }

    // Agrupa por sellerId
    const groups = new Map();
    for (const sale of sales) {
      const raw = sale?.raw_api_data || {};
      const sellerId = sale?.seller_id ?? raw?.seller?.id ?? raw?.seller_id;
      const shipmentIdRaw = raw?.shipping?.id ?? raw?.shipment_id ?? sale?.shipment_id;
      const shipmentId = shipmentIdRaw ? String(shipmentIdRaw).split('.')[0] : null;
      if (!sellerId || !shipmentId) continue;
      if (!groups.has(sellerId)) groups.set(sellerId, []);
      groups.get(sellerId).push(shipmentId);
    }

    if (groups.size === 0) {
      throw new Error('Não foi possível identificar seller_id e shipment_id nas vendas selecionadas.');
    }

    // Para cada seller, dispara um download (CSV de IDs)
    for (const [sellerId, ids] of groups.entries()) {
      if (!ids.length) continue;
      const url = `/ml/download-label?shipment_ids=${encodeURIComponent(ids.join(','))}&response_type=${type}&seller_id=${sellerId}`;

      try {
        const blob = await api.get(url, { responseType: 'blob' });
        if (blob && blob.type === 'application/json') {
          const text = await blob.text();
          try {
            const j = JSON.parse(text);
            throw new Error(j.message || j.error || 'Erro ao obter etiqueta em lote.');
          } catch {
            throw new Error(text || 'Erro ao obter etiqueta em lote.');
          }
        }
        if (!(blob instanceof Blob)) throw new Error('Resposta inválida do servidor (lote).');

        const fileURL = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = fileURL;
        a.setAttribute('download', `etiquetas-${sellerId}-${ids.length}.${type}`);
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(fileURL);
      } catch (err) {
        // Não interrompe outros grupos; apenas loga e segue
        console.error(`Falha ao baixar etiquetas do seller ${sellerId}:`, err);
      }
    }
  }

  return {
    getLabelInfo,
    checkLabelAvailability,
    downloadLabel,
    downloadLabelsForSales,
  };
}
