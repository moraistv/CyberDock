import { ref } from 'vue';
import { useApi } from './useApi'; // Importa o useApi

/**
 * Composable para gerenciar os usuários do sistema.
 */
export function useUsers() {
  const users = ref([]);
  const isLoading = ref(true);
  const error = ref(null);
  const api = useApi(); // Instancia o composable da API

  /**
   * Busca todos os usuários via API REST.
   */
  const fetchUsers = async () => {
    isLoading.value = true;
    error.value = null;
    try {
      // Usa o método get do useApi que já inclui o token
      const usersData = await api.get('/users/all');
      users.value = usersData.map(u => ({
        uid: u.uid,
        email: u.email,
        name: u.name || null,
        role: u.role,
        active: u.active !== false, // padrao true
        createdAt: u.createdAt || u.created_at || null,
        mlNickname: u.mlNickname || null,
      }));
    } catch (err) {
      console.error("Erro ao buscar usuários:", err);
      error.value = err.message || "Não foi possível carregar a lista de usuários.";
    } finally {
      isLoading.value = false;
    }
  };

  /**
   * Atualiza a permissão (role) de um usuário específico via API.
   * @param {string} uid - O UID do usuário a ser atualizado.
   * @param {string} newRole - A nova permissão ('master' ou 'cliente').
   */
  const updateUserRole = async (uid, newRole) => {
    try {
      const response = await api.put(`/users/${uid}/role`, { role: newRole });
      
      // Atualiza o usuário na lista localmente para feedback instantâneo
      const userIndex = users.value.findIndex(u => u.uid === uid);
      if (userIndex !== -1) {
        users.value[userIndex].role = newRole;
      }
      return { success: true, message: response.message };
    } catch (err) {
      console.error(`Erro ao atualizar permissão para ${uid}:`, err);
      // Recarrega a lista de usuários para reverter a mudança visual em caso de erro
      await fetchUsers(); 
      return { success: false, message: err.message || 'Falha ao atualizar permissão.' };
    }
  };

  /**
   * Ativa ou inativa um usuário específico via API.
   * @param {string} uid - O UID do usuário a ser atualizado.
   * @param {boolean} currentStatus - O status ATUAL (iremos inverter no payload)
   */
  const toggleUserActiveStatus = async (uid, currentStatus) => {
    const newStatus = !currentStatus;
    try {
      const response = await api.put(`/users/${uid}/active`, { active: newStatus });
      
      // Atualiza localmente
      const userIndex = users.value.findIndex(u => u.uid === uid);
      if (userIndex !== -1) {
        users.value[userIndex].active = newStatus;
      }
      return { success: true, message: response.message || 'Status alterado com sucesso.' };
    } catch (err) {
      console.error(`Erro ao atualizar status para ${uid}:`, err);
      // Reverter visualmente
      await fetchUsers(); 
      return { success: false, message: err.message || 'Falha ao atualizar status.' };
    }
  };

  /**
   * Exclui um usuário específico via API.
   * @param {string} uid - O UID do usuário a ser excluído.
   */
  const deleteUser = async (uid) => {
    try {
      const response = await api.delete(`/users/${uid}`);
      // Remove o usuário da lista local
      users.value = users.value.filter(u => u.uid !== uid);
      return { success: true, message: response.message };
    } catch (err) {
      console.error(`Erro ao excluir usuário ${uid}:`, err);
      return { success: false, message: err.message || 'Falha ao excluir usuário.' };
    }
  };

  return {
    users,
    isLoading,
    error,
    fetchUsers,
    updateUserRole,
    toggleUserActiveStatus,
    deleteUser, // Exporta a nova função
  };
}
