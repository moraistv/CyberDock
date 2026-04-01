// src/composables/useUserAccounts.js
import { ref, watch } from 'vue';
import { useApi } from './useApi';

/**
 * Composable para buscar as contas do Mercado Livre de um usuário específico.
 * @param {import('vue').Ref<string>} userIdRef - A referência reativa para o UID do usuário.
 */
export function useUserAccounts(userIdRef) {
  const accounts = ref([]);
  const isLoading = ref(false);
  const error = ref(null);
  const api = useApi();

  /**
   * Busca as contas de um usuário específico a partir da API.
   * @param {string} uid - O UID do usuário.
   */
  const fetchAccounts = async (uid) => {
    if (!uid) {
      accounts.value = [];
      return [];
    }
    isLoading.value = true;
    error.value = null;
    try {
      // Esta rota busca as contas associadas ao UID fornecido.
      // Deve corresponder à rota no backend: GET /api/ml/contas/:uid
      const data = await api.get(`/ml/contas/${uid}`);
      accounts.value = data || [];
      return accounts.value;
    } catch (e) {
      console.error(`Erro ao buscar contas ML para o usuário ${uid}:`, e);
      error.value = 'Não foi possível carregar as contas do Mercado Livre do usuário.';
      accounts.value = [];
      return [];
    } finally {
      isLoading.value = false;
    }
  };

  // Observa mudanças no userIdRef e busca as contas automaticamente.
  watch(userIdRef, (newId) => {
    if (newId) {
      fetchAccounts(newId);
    }
  }, { immediate: true });

  return {
    accounts,
    isLoading,
    error,
    fetchAccounts,
  };
}
