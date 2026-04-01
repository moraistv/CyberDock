import { ref, computed, watch } from 'vue';
import { useApi } from './useApi';

export function useKitParent(userId) {
  const { get, post, put, patch, delete: del } = useApi();
  
  const kitParents = ref([]);
  const activeKitParents = ref([]);
  const isLoading = ref(false);
  const error = ref(null);

  // Carregar todos os kits pai de um usuário
  const loadKitParents = async () => {
    if (!userId.value) return;
    
    isLoading.value = true;
    error.value = null;
    
    try {
      const response = await get(`/kit-parent/user/${userId.value}`);
      
      if (response.error) {
        throw new Error(response.error);
      }
      
      kitParents.value = response || [];
    } catch (err) {
      error.value = err.message || 'Erro ao carregar kits pai';
      console.error('Erro ao carregar kits pai:', err);
    } finally {
      isLoading.value = false;
    }
  };

  // Carregar apenas kits pai ativos para seleção
  const loadActiveKitParents = async () => {
    console.log('🔍 [useKitParent] loadActiveKitParents iniciado');
    console.log('🔍 [useKitParent] userId.value:', userId.value);
    
    if (!userId.value) {
      console.log('❌ [useKitParent] userId não encontrado, retornando');
      return;
    }
    
    try {
      const url = `/kit-parent/user/${userId.value}/active`;
      console.log('🌐 [useKitParent] Fazendo requisição para:', url);
      
      const response = await get(url);
      
      console.log('📡 [useKitParent] Resposta recebida:', response);
      console.log('📡 [useKitParent] Tipo da resposta:', typeof response);
      console.log('📡 [useKitParent] Array.isArray(response):', Array.isArray(response));
      
      if (response && response.error) {
        console.error('❌ [useKitParent] Resposta contém erro:', response.error);
        throw new Error(response.error);
      }
      
      const kitParentsData = response || [];
      console.log('✅ [useKitParent] Kit parents processados:', kitParentsData);
      console.log('✅ [useKitParent] Quantidade de kit parents:', kitParentsData.length);
      
      activeKitParents.value = kitParentsData;
      
      console.log('✅ [useKitParent] activeKitParents.value atualizado:', activeKitParents.value);
    } catch (err) {
      console.error('💥 [useKitParent] Erro ao carregar kits pai ativos:', err);
      console.error('💥 [useKitParent] Stack trace:', err.stack);
      activeKitParents.value = [];
    }
  };

  // Criar novo kit pai
  const createKitParent = async (kitData) => {
    console.log('🚀 [DEBUG] Iniciando criação de kit pai');
    console.log('🔑 [DEBUG] userId.value:', userId.value);
    console.log('📦 [DEBUG] kitData recebido:', kitData);
    
    if (!userId.value) {
      console.error('❌ [DEBUG] User ID não encontrado');
      throw new Error('User ID é obrigatório');
    }
    
    const payload = {
      nome: String(kitData.nome || '').trim(),
      descricao: String(kitData.descricao || '').trim(),
      ativo: Boolean(kitData.ativo ?? true)
    };

    console.log('📋 [DEBUG] Payload preparado:', payload);

    if (!payload.nome || !payload.descricao) {
      console.error('❌ [DEBUG] Validação falhou - dados obrigatórios faltando');
      throw new Error('Nome e descrição são obrigatórios');
    }

    console.log('✅ [DEBUG] Validação passou, fazendo requisição HTTP');
    
    try {
      const url = `/kit-parent/user/${userId.value}`;
      console.log('🌐 [DEBUG] URL da requisição:', url);
      
      const response = await post(url, payload);
      
      console.log('📡 [DEBUG] Resposta recebida:', response);

      if (response.error) {
        console.error('❌ [DEBUG] Resposta contém erro:', response.error);
        throw new Error(response.error);
      }

      // Atualizar a lista local
      console.log('🔄 [DEBUG] Atualizando lista local de kits');
      kitParents.value.unshift(response);
      
      // Atualizar lista de ativos se necessário
      if (response.ativo) {
        console.log('✅ [DEBUG] Kit é ativo, adicionando à lista de ativos');
        activeKitParents.value.push({
          id: response.id,
          nome: response.nome,
          descricao: response.descricao
        });
        // Ordenar por nome
        activeKitParents.value.sort((a, b) => a.nome.localeCompare(b.nome));
      }

      console.log('🎉 [DEBUG] Kit pai criado com sucesso:', response);
      return response;
    } catch (err) {
      console.error('💥 [DEBUG] Erro detalhado ao criar kit pai:');
      console.error('💥 [DEBUG] Tipo do erro:', typeof err);
      console.error('💥 [DEBUG] Erro completo:', err);
      console.error('💥 [DEBUG] Mensagem do erro:', err.message);
      console.error('💥 [DEBUG] Stack trace:', err.stack);
      
      if (err.response) {
        console.error('💥 [DEBUG] Resposta do servidor:', err.response);
        console.error('💥 [DEBUG] Status da resposta:', err.response.status);
        console.error('💥 [DEBUG] Dados da resposta:', err.response.data);
      }
      
      throw new Error(err.message || 'Erro ao criar kit pai');
    }
  };

  // Atualizar kit pai existente
  const updateKitParent = async (kitId, kitData) => {
    if (!userId.value) throw new Error('User ID é obrigatório');
    
    const payload = {
      nome: String(kitData.nome || '').trim(),
      descricao: String(kitData.descricao || '').trim(),
      ativo: Boolean(kitData.ativo ?? true)
    };

    if (!payload.nome || !payload.descricao) {
      throw new Error('Nome e descrição são obrigatórios');
    }

    try {
      const response = await put(`/kit-parent/user/${userId.value}/${kitId}`, payload);

      if (response.error) {
        throw new Error(response.error);
      }

      // Atualizar na lista local
      const index = kitParents.value.findIndex(kit => kit.id === kitId);
      if (index !== -1) {
        kitParents.value[index] = response;
      }

      // Atualizar lista de ativos
      await loadActiveKitParents();

      return response;
    } catch (err) {
      throw new Error(err.message || 'Erro ao atualizar kit pai');
    }
  };

  // Alternar status ativo/inativo
  const toggleKitParentStatus = async (kitId) => {
    if (!userId.value) throw new Error('User ID é obrigatório');
    
    try {
      const response = await patch(`/kit-parent/user/${userId.value}/${kitId}/toggle-status`);

      if (response.error) {
        throw new Error(response.error);
      }

      // Atualizar na lista local
      const index = kitParents.value.findIndex(kit => kit.id === kitId);
      if (index !== -1) {
        kitParents.value[index] = response;
      }

      // Atualizar lista de ativos
      await loadActiveKitParents();

      return response;
    } catch (err) {
      throw new Error(err.message || 'Erro ao alterar status do kit pai');
    }
  };

  // Excluir kit pai
  const deleteKitParent = async (kitId) => {
    if (!userId.value) throw new Error('User ID é obrigatório');
    
    try {
      const response = await del(`/kit-parent/user/${userId.value}/${kitId}`);

      if (response.error) {
        throw new Error(response.error);
      }

      // Remover da lista local
      kitParents.value = kitParents.value.filter(kit => kit.id !== kitId);
      activeKitParents.value = activeKitParents.value.filter(kit => kit.id !== kitId);

      return response;
    } catch (err) {
      throw new Error(err.message || 'Erro ao excluir kit pai');
    }
  };

  // Watch para recarregar quando userId mudar
  watch(userId, (newUserId, oldUserId) => {
    console.log('🔄 [useKitParent] userId watch ativado');
    console.log('🔄 [useKitParent] newUserId:', newUserId);
    console.log('🔄 [useKitParent] oldUserId:', oldUserId);
    
    if (newUserId) {
      console.log('🚀 [useKitParent] Carregando dados para userId:', newUserId);
      loadKitParents();
      loadActiveKitParents();
    } else {
      console.log('⚠️ [useKitParent] newUserId é falsy, não carregando dados');
    }
  }, { immediate: true });

  // Computed para estatísticas
  const stats = computed(() => ({
    total: kitParents.value.length,
    active: kitParents.value.filter(kit => kit.ativo).length,
    inactive: kitParents.value.filter(kit => !kit.ativo).length
  }));

  return {
    // Estado
    kitParents,
    activeKitParents,
    isLoading,
    error,
    stats,
    
    // Métodos
    loadKitParents,
    loadActiveKitParents,
    createKitParent,
    updateKitParent,
    toggleKitParentStatus,
    deleteKitParent
  };
}