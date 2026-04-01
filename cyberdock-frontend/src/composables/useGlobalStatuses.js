import { ref } from 'vue';
import { useApi } from '@/composables/useApi';

export function useGlobalStatuses() {
  const api = useApi();
  const globalStatuses = ref([]);
  const isLoading = ref(true);
  const error = ref(null);

  const fetchGlobalStatuses = async () => {
    isLoading.value = true;
    error.value = null;
    try {
      const data = await api.get('/settings/statuses');
      globalStatuses.value = data.statuses || [];
    } catch (e) {
      console.error('Erro ao buscar status globais:', e);
      error.value = e.message;
      globalStatuses.value = [];
    } finally {
      isLoading.value = false;
    }
  };

  const saveGlobalStatuses = async (newStatusesList) => {
    try {
      await api.put('/settings/statuses', { statuses: newStatusesList });
      globalStatuses.value = newStatusesList;
    } catch (e) {
      console.error('Erro ao salvar status globais:', e);
      await fetchGlobalStatuses(); // rollback
      throw e;
    }
  };

  const addGlobalStatus = async (statusName) => {
    const trimmedName = statusName.trim();
    if (!trimmedName) {
      throw new Error('O nome do status não pode estar vazio.');
    }

    const value = `global_${trimmedName.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}`;
    const labelExists = globalStatuses.value.some(s => s.label.toLowerCase() === trimmedName.toLowerCase());

    if (labelExists) {
      throw new Error('Este status já existe globalmente.');
    }

    const newStatus = { label: trimmedName, value };
    const updatedList = [...globalStatuses.value, newStatus];
    await saveGlobalStatuses(updatedList);
  };

  const updateGlobalStatus = async (statusValue, newLabel) => {
    const trimmedLabel = newLabel.trim();
    if (!trimmedLabel) {
      throw new Error('O nome do status não pode estar vazio.');
    }
    
    const index = globalStatuses.value.findIndex(s => s.value === statusValue);
    if (index === -1) {
      throw new Error('Status original não encontrado.');
    }

    const labelExists = globalStatuses.value.some(s => s.label.toLowerCase() === trimmedLabel.toLowerCase() && s.value !== statusValue);
    if (labelExists) {
      throw new Error('Já existe um status global com esse nome.');
    }

    const updatedList = [...globalStatuses.value];
    updatedList[index] = { ...updatedList[index], label: trimmedLabel };
    
    await saveGlobalStatuses(updatedList);
  };

  const deleteGlobalStatus = async (statusToDelete) => {
    const updatedList = globalStatuses.value.filter(s => s.value !== statusToDelete.value);
    await saveGlobalStatuses(updatedList);
  };

  return {
    globalStatuses,
    isLoading,
    error,
    fetchGlobalStatuses,
    saveGlobalStatuses,
    addGlobalStatus,
    updateGlobalStatus,
    deleteGlobalStatus
  };
}
