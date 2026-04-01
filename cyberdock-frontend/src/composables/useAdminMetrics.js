import { ref } from 'vue';
// 1. Importa as funções do Firebase Realtime Database
import { getDatabase, ref as dbRef, get } from 'firebase/database';

// Estado reativo para armazenar as métricas.
const metrics = ref({
  totalUsers: 0,       // Alterado de 'newSignups'
  connectedAccounts: 0,
  onlineUsers: 0,      // Será mantido como estático por enquanto
  apiErrors: 0,        // Será mantido como estático por enquanto
});

// Estado para controlar o carregamento.
const isLoading = ref(true);

/**
 * Composable para buscar e gerenciar as métricas do painel de administração.
 */
export function useAdminMetrics() {
  const db = getDatabase();

  /**
   * Busca os dados reais do Firebase Realtime Database.
   */
  const fetchMetrics = async () => {
    isLoading.value = true;
    
    try {
      // 2. Cria referências para os nós do banco de dados que queremos consultar.
      const usersRef = dbRef(db, 'users');
      const mlAccountsRef = dbRef(db, 'ml_accounts');

      // 3. Executa as consultas ao banco de dados em paralelo.
      const [usersSnapshot, mlAccountsSnapshot] = await Promise.all([
        get(usersRef),
        get(mlAccountsRef),
      ]);

      // 4. Calcula o total de usuários.
      let totalUsers = 0;
      if (usersSnapshot.exists()) {
        totalUsers = Object.keys(usersSnapshot.val()).length;
      }

      // 5. Calcula o total de contas conectadas.
      let totalConnectedAccounts = 0;
      if (mlAccountsSnapshot.exists()) {
        const allUserAccounts = mlAccountsSnapshot.val();
        // Itera sobre cada usuário para somar suas contas
        totalConnectedAccounts = Object.values(allUserAccounts).reduce((total, userAccounts) => {
          return total + Object.keys(userAccounts).length;
        }, 0);
      }
      
      // 6. Atualiza o estado das métricas com os dados reais.
      metrics.value = {
        totalUsers: totalUsers,
        connectedAccounts: totalConnectedAccounts,
        onlineUsers: 0, // Métrica complexa, mantida como 0 por enquanto.
        apiErrors: 0,   // Métrica complexa, mantida como 0 por enquanto.
      };

    } catch (error) {
      console.error("Erro ao buscar métricas do Firebase:", error);
      // Em caso de erro, define valores padrão para evitar quebrar a interface.
      metrics.value = {
        totalUsers: 0,
        connectedAccounts: 0,
        onlineUsers: 0,
        apiErrors: 0,
      };
    } finally {
      isLoading.value = false;
    }
  };

  return {
    metrics,
    isLoading,
    fetchMetrics,
  };
}
