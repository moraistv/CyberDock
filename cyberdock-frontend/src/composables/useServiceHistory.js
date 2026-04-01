import { ref } from 'vue';
import { useApi } from './useApi';

export function useServiceHistory() {
  const api = useApi();
  const contractHistory = ref([]);
  const manualHistory = ref([]);
  const isLoading = ref(false);
  const error = ref(null);

  const fetchContractHistory = async (filters = {}) => {
    isLoading.value = true;
    error.value = null;
    try {
      const params = new URLSearchParams();
      if (filters.clientId) params.append('clientId', filters.clientId);
      if (filters.serviceId) params.append('serviceId', filters.serviceId);

      const q = params.toString();
      contractHistory.value = await api.get(`/history/contracts${q ? `?${q}` : ''}`);
    } catch (e) {
      console.error('Erro ao buscar histórico de contratos:', e);
      error.value = e?.message || 'Falha ao carregar o histórico de contratos.';
    } finally {
      isLoading.value = false;
    }
  };

  const fetchManualHistory = async (filters = {}) => {
    isLoading.value = true;
    error.value = null;
    try {
      const params = new URLSearchParams();
      if (filters.clientId) params.append('clientId', filters.clientId);

      const q = params.toString();
      manualHistory.value = await api.get(`/history/manual${q ? `?${q}` : ''}`);
    } catch (e) {
      console.error('Erro ao buscar histórico de serviços avulsos:', e);
      error.value = e?.message || 'Falha ao carregar o histórico de serviços avulsos.';
    } finally {
      isLoading.value = false;
    }
  };

  const updateManualService = async (serviceId, serviceData) => {
    try {
      await api.put(`/history/manual/${serviceId}`, serviceData);
      const index = manualHistory.value.findIndex(s => s.id === serviceId);
      if (index !== -1) {
        manualHistory.value[index] = { ...manualHistory.value[index], ...serviceData };
      }
      return { success: true };
    } catch (e) {
      console.error('Erro ao atualizar serviço avulso:', e);
      return { success: false, error: e.message || 'Erro desconhecido.' };
    }
  };

  const deleteManualService = async (serviceId) => {
    try {
      await api.delete(`/history/manual/${serviceId}`);
      manualHistory.value = manualHistory.value.filter(s => s.id !== serviceId);
      return { success: true };
    } catch (e) {
      console.error('Erro ao excluir serviço avulso:', e);
      return { success: false, error: e.message || 'Erro desconhecido.' };
    }
  };

  return {
    contractHistory,
    manualHistory,
    isLoading,
    error,
    fetchContractHistory,
    fetchManualHistory,
    updateManualService,
    deleteManualService,
  };
}
