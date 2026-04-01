import { ref, onMounted } from 'vue';
import { useApi } from './useApi';

/**
 * Composable para buscar os status de venda GLOBAIS do sistema (da tabela system_settings).
 * Acessível por qualquer usuário autenticado que precise da lista padrão.
 */
export function useSystemStatus() {
  const systemStatuses = ref([]);
  const isLoading = ref(true);
  const error = ref(null);
  const api = useApi();

  /**
   * Busca a lista de status globais a partir da API.
   */
  const fetchSystemStatuses = async () => {
    isLoading.value = true;
    error.value = null;
    try {
      // Esta rota busca os status definidos na tabela system_settings
      const data = await api.get('/settings/statuses');
      systemStatuses.value = data.statuses || [];
    } catch (e) {
      console.error("Erro ao buscar status globais do sistema:", e);
      error.value = 'Não foi possível carregar a lista de status do sistema.';
      systemStatuses.value = [];
    } finally {
      isLoading.value = false;
    }
  };

  // Carrega os status assim que o composable é instanciado no componente.
  onMounted(fetchSystemStatuses);

  return {
    systemStatuses,
    isLoading,
    error,
    fetchSystemStatuses,
  };
}
