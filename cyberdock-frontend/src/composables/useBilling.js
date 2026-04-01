// src/composables/useBilling.js
import { ref } from 'vue';
import { useApi } from './useApi';

export function useBilling() {
  const invoices = ref([]);
  const billingSummary = ref([]);
  const manualServices = ref([]); // serviços avulsos, vindos de /services?manualOnly=1
  const isLoading = ref(false);
  const error = ref(null);
  const api = useApi();

  const fetchInvoices = async (uid, period = null) => {
    if (!uid) return;
    isLoading.value = true;
    error.value = null;
    try {
      let url = `/billing/invoices/${uid}`;
      if (period) {
        url += `?period=${period}`;
      }
      const data = await api.get(url);
      invoices.value = data.map(inv => {
        const dueDate = new Date(inv.due_date);
        const formattedDueDate = `${String(dueDate.getUTCDate()).padStart(2, '0')}/${String(dueDate.getUTCMonth() + 1).padStart(2, '0')}/${dueDate.getUTCFullYear()}`;

        let formattedPaymentDate = null;
        if (inv.payment_date) {
          const paymentDate = new Date(inv.payment_date);
          formattedPaymentDate = `${String(paymentDate.getUTCDate()).padStart(2, '0')}/${String(paymentDate.getUTCMonth() + 1).padStart(2, '0')}/${paymentDate.getUTCFullYear()}`;
        }

        return {
          ...inv,
          totalAmount: parseFloat(inv.total_amount),
          dueDate: formattedDueDate,
          paymentDate: formattedPaymentDate,
          items: inv.items || []
        };
      });
    } catch (e) {
      console.error('Erro ao buscar faturas:', e);
      error.value = e.message || 'Falha ao carregar faturas.';
      invoices.value = [];
    } finally {
      isLoading.value = false;
    }
  };

  const fetchBillingSummary = async () => {
    isLoading.value = true;
    error.value = null;
    try {
      const data = await api.get('/billing/summary');
      billingSummary.value = data.map(s => ({
        ...s,
        last_invoice_total: s.last_invoice_total ? parseFloat(s.last_invoice_total) : 0,
      }));
    } catch (e) {
      console.error('Erro ao buscar resumo de faturamento:', e);
      error.value = e.message || 'Falha ao carregar resumo.';
      billingSummary.value = [];
    } finally {
      isLoading.value = false;
    }
  };

  // Busca os serviços que podem ser lançados manualmente (catálogo)
  const fetchManualServices = async () => {
    try {
      // agora puxa do catálogo, com filtro manualOnly
      const data = await api.get('/services?manualOnly=1');
      manualServices.value = data; // [{id,name,type,price,config}, ...]
    } catch (e) {
      console.error('Erro ao buscar serviços avulsos:', e);
      // não popula error global
    }
  };

  // Adiciona um item de serviço manual na fatura
  const addManualService = async (payload) => {
    return api.post('/billing/add-manual-item', payload);
  };

  return {
    invoices,
    billingSummary,
    manualServices,
    isLoading,
    error,
    fetchInvoices,
    fetchBillingSummary,
    fetchManualServices,
    addManualService,
  };
}
