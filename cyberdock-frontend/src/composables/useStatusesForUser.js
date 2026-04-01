import { ref, computed, watch } from 'vue';
import { useApi } from '@/composables/useApi';

export function useStatusesForUser(uidRef) {
  const api = useApi();
  const statuses = ref([]);
  const isLoading = ref(true);
  const error = ref(null);

  const allStatuses = computed(() => statuses.value);

  const loadStatuses = async () => {
    const uid = uidRef.value;
    if (!uid) {
        error.value = 'UID do usuário não fornecido para carregar status.';
        statuses.value = [];
        isLoading.value = false;
        return;
    }
    isLoading.value = true;
    error.value = null;
    
    try {
        const customStatusesData = await api.get(`/users/statuses/${uid}`);
        
        if (customStatusesData.statuses && customStatusesData.statuses.length > 0) {
            statuses.value = customStatusesData.statuses;
        } else {
            const systemStatusesData = await api.get('/settings/statuses');
            statuses.value = systemStatusesData.statuses || [];
        }

    } catch (e) {
        console.error("Erro ao carregar status do usuário pela API:", e);
        error.value = e.message;
        statuses.value = [];
    } finally {
        isLoading.value = false;
    }
  };

  const saveCustomStatuses = async (newStatusesList) => {
    const uid = uidRef.value;
    if (!uid) {
        throw new Error('UID do usuário não fornecido para salvar status.');
    }
    try {
        await api.put(`/users/statuses/${uid}`, { statuses: newStatusesList });
        statuses.value = newStatusesList;
    } catch (e) {
        console.error("Erro ao salvar status do usuário na API:", e);
        await loadStatuses(); 
        throw e;
    }
  };

  const addStatus = async (statusName) => {
    const trimmedName = statusName.trim();
    if (!trimmedName) {
        throw new Error('O nome do status não pode estar vazio.');
    }

    const value = `custom_${trimmedName.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}`;
    const labelExists = statuses.value.some(s => s.label.toLowerCase() === trimmedName.toLowerCase());

    if (labelExists) {
        throw new Error('Este status já existe.');
    }

    const newStatus = { label: trimmedName, value };
    const updatedList = [...statuses.value, newStatus];
    await saveCustomStatuses(updatedList);
  };

  const updateStatus = async (statusValue, newLabel) => {
    const trimmedLabel = newLabel.trim();
    if (!trimmedLabel) {
      throw new Error('O nome do status não pode estar vazio.');
    }
    
    const index = statuses.value.findIndex(s => s.value === statusValue);
    if (index === -1) {
      throw new Error('Status original não encontrado.');
    }

    const labelExists = statuses.value.some(s => s.label.toLowerCase() === trimmedLabel.toLowerCase() && s.value !== statusValue);
    if (labelExists) {
      throw new Error('Já existe um status com esse nome.');
    }

    const updatedList = [...statuses.value];
    updatedList[index] = { ...updatedList[index], label: trimmedLabel };
    
    await saveCustomStatuses(updatedList);
  };

  const deleteStatus = async (statusToDelete) => {
    const updatedList = statuses.value.filter(s => s.value !== statusToDelete.value);
    await saveCustomStatuses(updatedList);
  };

  watch(uidRef, (newUid) => {
      if (newUid) {
          loadStatuses();
      } else {
          statuses.value = [];
          error.value = null;
          isLoading.value = false;
      }
  }, { immediate: true });

  return {
    allStatuses,
    isLoading,
    error,
    loadStatuses,
    saveCustomStatuses,
    addStatus,
    updateStatus,
    deleteStatus,
  };
}
