import { ref, computed, watch } from 'vue';
import { useApi } from './useApi';
import { useUserStorage } from './useUserStorage'; // Importa o composable principal

export function useKitManagement(userId) {
  const { get, post, put, delete: del } = useApi();
  const userStorage = useUserStorage(userId); // Instancia o storage principal para sincronização

  // Estados
  const kits = ref([]);
  const activeKits = ref([]);
  const availableChildSkus = ref([]);
  const isLoading = ref(false);
  const isLoadingActiveKits = ref(false);
  const isLoadingChildSkus = ref(false);
  const error = ref(null);

  // Função para forçar a atualização do estado global
  const syncWithGlobalState = () => {
    if (userStorage && typeof userStorage.loadStorageData === 'function') {
      userStorage.loadStorageData();
    }
  };

  // Carregar todos os kits (ativos e inativos) de um usuário
  const loadKits = async () => {
    if (!userId.value) return;
    
    isLoading.value = true;
    error.value = null;
    
    try {
      const response = await get(`/storage/user/${userId.value}/skus`);
      if (response.error) throw new Error(response.error);
      kits.value = (response || []).filter(sku => sku.is_kit);
    } catch (err) {
      error.value = err.message || 'Erro ao carregar kits';
      console.error('Erro ao carregar kits:', err);
      kits.value = [];
    } finally {
      isLoading.value = false;
    }
  };

  // Carregar apenas kits ativos para exibição na gestão de SKUs
  const loadActiveKits = async () => {
    if (!userId.value) return;
    
    isLoadingActiveKits.value = true;
    
    try {
      const response = await get(`/storage/user/${userId.value}/skus`);
      if (response.error) throw new Error(response.error);
      
      const activeKitsData = (response || []).filter(sku => sku.is_kit && sku.ativo);
      
      activeKits.value = activeKitsData.map(kit => ({
        ...kit,
        available_quantity: calculateKitAvailableQuantity(kit),
        kit_components: kit.kit_components || []
      }));
    } catch (err) {
      console.error('Erro ao carregar kits ativos:', err);
      activeKits.value = [];
    } finally {
      isLoadingActiveKits.value = false;
    }
  };

  // Carregar SKUs filhos disponíveis para criação de kits (OTIMIZADO)
  const loadAvailableChildSkus = async () => {
    if (!userId.value) return;
    
    isLoadingChildSkus.value = true;
    
    try {
      // USA A ROTA OTIMIZADA DO BACKEND
      const response = await get(`/storage/user/${userId.value}/available-child-skus`);
      if (response.error) throw new Error(response.error);
      availableChildSkus.value = response || [];
    } catch (err) {
      console.error('Erro ao carregar SKUs filhos:', err);
      availableChildSkus.value = [];
    } finally {
      isLoadingChildSkus.value = false;
    }
  };

  // Calcular quantidade disponível de um kit baseado nos componentes
  const calculateKitAvailableQuantity = (kit) => {
    // Se não há componentes ou se é um kit simples, retorna 0
    if (!kit.kit_components || kit.kit_components.length === 0) {
      return 0; // Kit sem componentes sempre mostra 0
    }
    
    // Se há componentes, calcula baseado no estoque disponível
    return Math.min(...kit.kit_components.map(component => {
      // Verifica se o componente tem estoque disponível
      const childStock = component.child_stock || component.quantidade || 0;
      const quantityPerKit = component.quantity_per_kit || 1;
      
      if (childStock <= 0 || quantityPerKit <= 0) {
        return 0;
      }
      
      const availableFromChild = Math.floor(childStock / quantityPerKit);
      return isNaN(availableFromChild) ? 0 : availableFromChild;
    }));
  };

  // Criar novo kit
  const createKit = async (kitData) => {
    console.log('🚀 [useKitManagement] Criando kit para usuário:', userId.value);
    
    if (!userId.value) {
      throw new Error('User ID é obrigatório');
    }
    
    const payload = {
      sku: String(kitData.sku || '').trim(),
      descricao: String(kitData.descricao || '').trim(),
      dimensoes: { altura: 0, largura: 0, comprimento: 0 },
      quantidade: 0,
      package_type_id: kitData.package_type_id || null,
      is_kit: true,
      ativo: Boolean(kitData.ativo ?? true),
      kit_components: kitData.kit_components || []
    };

    if (!payload.sku || !payload.descricao) {
      throw new Error('SKU e descrição são obrigatórios');
    }

    try {
      console.log('📡 [useKitManagement] Enviando requisição para:', `/storage/user/${userId.value}/skus`);
      
      const response = await post(`/storage/user/${userId.value}/skus`, payload);
      
      if (response.error) {
        throw new Error(response.error);
      }

      console.log('✅ [useKitManagement] Kit criado com sucesso');

      // Recarregar dados
      await loadKits();
      if (payload.ativo) await loadActiveKits();
      
      // Sincronizar com estado global
      if (userStorage && typeof userStorage.loadStorageData === 'function') {
        userStorage.loadStorageData();
      }

      return response;
    } catch (err) {
      console.error('💥 [useKitManagement] Erro ao criar kit:', err.message);
      const errorMessage = err.response?.data?.error || err.message || 'Erro ao criar kit';
      throw new Error(errorMessage);
    }
  };

  // Atualizar kit existente
  const updateKit = async (kitId, kitData) => {
    if (!userId.value) throw new Error('User ID é obrigatório');
    
    try {
      const response = await put(`/storage/skus/${kitId}`, {
        descricao: kitData.descricao,
        dimensoes: kitData.dimensoes,
        package_type_id: kitData.package_type_id,
        kit_components: kitData.kit_components,
        ativo: kitData.ativo
      });

      if (response.error) throw new Error(response.error);

      await loadKits();
      await loadActiveKits();
      
      syncWithGlobalState(); // SINCRONIZA COM O ESTADO GLOBAL

      return response;
    } catch (err) {
      console.error('Falha detalhada ao atualizar kit:', err);
      const errorMessage = err.response?.data?.error || err.message || 'Erro desconhecido ao atualizar kit.';
      throw new Error(errorMessage);
    }
  };

  // Ativar/desativar kit (IMPLEMENTADO)
  const toggleKitStatus = async (kitId) => {
    const kit = kits.value.find(k => k.id === kitId);
    if (!kit) throw new Error('Kit não encontrado');
    
    // O payload para o PUT precisa de todos os campos que o backend espera
    const payload = {
      descricao: kit.descricao,
      dimensoes: kit.dimensoes,
      package_type_id: kit.package_type_id,
      kit_components: kit.kit_components,
      ativo: !kit.ativo // Inverte o status atual
    };
    
    await updateKit(kitId, payload); // Reutiliza a função de update
  };

  // Excluir kit
  const deleteKit = async (kitId) => {
    if (!userId.value) throw new Error('User ID é obrigatório');
    try {
      const response = await del(`/storage/skus/${kitId}`);
      if (response.error) throw new Error(response.error);

      await loadKits();
      await loadActiveKits();

      syncWithGlobalState(); // SINCRONIZA COM O ESTADO GLOBAL

      return response;
    } catch (err) {
      console.error('Falha ao excluir kit:', err);
      const errorMessage = err.response?.data?.error || err.message || 'Erro ao excluir kit.';
      throw new Error(errorMessage);
    }
  };

  watch(userId, (newUserId) => {
    if (newUserId) {
      loadKits();
      loadActiveKits();
    }
  }, { immediate: true });

  // ✅ Renomeado para evitar o warning do ESLint
  const statsRef = computed(() => ({
    total: kits.value.length,
    active: kits.value.filter(kit => kit.ativo).length,
    inactive: kits.value.filter(kit => !kit.ativo).length
  }));

  const inactiveKits = computed(() => kits.value.filter(kit => !kit.ativo));

  return {
    kits,
    activeKits,
    inactiveKits,
    availableChildSkus,
    isLoading,
    isLoadingActiveKits,
    isLoadingChildSkus,
    error,

    // Exporta como 'stats' (consumido pelo componente), mas internamente é 'statsRef'
    stats: statsRef,

    loadKits,
    loadActiveKits,
    loadAvailableChildSkus,
    createKit,
    updateKit,
    toggleKitStatus,
    deleteKit,
    calculateKitAvailableQuantity,
  };
}