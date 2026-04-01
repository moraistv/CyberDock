// src/composables/useSyncManager.js
import { ref } from 'vue';
import { useApi } from './useApi';
import { API_BASE_URL } from '@/config.js';
import { useAuth } from '@/composables/useAuth';

export function useSyncManager() {
  const api = useApi();
  const { token } = useAuth();
  let eventSource = null;

  const state = ref({
    isSyncing: false,
    isVisible: false,
    title: 'Sincronização',
    description: 'Iniciando...',
    progress: 0,
    type: 'info',
    newSalesCount: 0
  });

  const closeToast = (delay = 6000) => {
    if (state.value.progress === 100 || state.value.progress === -1) {
      setTimeout(() => {
        state.value.isVisible = false;
        state.value.progress = 0;
      }, delay);
    }
  };

    // Função para verificar se a conta já foi sincronizada recentemente
    const shouldForceSync = async (mlAccountId, clientUid = null) => {
      try {
        const endpoint = clientUid
          ? `/sales/last-sync/${mlAccountId}?clientUid=${encodeURIComponent(clientUid)}`
          : `/sales/last-sync/${mlAccountId}`;
        const response = await api.get(endpoint);
        if (!response || !response.lastSync) return true; // Força se nunca foi sincronizada
  
        const lastSync = new Date(response.lastSync);
        const now = new Date();
        const hoursSinceLastSync = (now - lastSync) / (1000 * 60 * 60);
  
        // Se passou mais de 1 hora, força sincronização
        return hoursSinceLastSync > 1;
      } catch (err) {
        console.warn('Erro ao verificar última sincronização, forçando:', err);
        return true; // Em caso de erro, força sincronização
      }
    };

  // Aceita mlAccountId, accountNickname e clientUid
  const syncAccount = async (mlAccountId, accountNickname, clientUid = null) => {
    return new Promise((resolve, reject) => {
      if (state.value.isSyncing) {
        console.warn("A sincronização já está em andamento.");
        return reject(new Error("Uma sincronização já está em andamento."));
      }

      // Verifica se deve forçar sincronização usando .then() em vez de await
      shouldForceSync(mlAccountId, clientUid)
        .then(force => {
          const clientId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          state.value = {
            isSyncing: true,
            isVisible: true,
            progress: 0,
            title: `Sincronizando: ${accountNickname}`,
            description: force ? 'Forçando sincronização completa...' : 'Verificando atualizações...',
            type: 'info',
            newSalesCount: 0
          };

          // Adiciona o clientUid no payload da requisição
          api.post('/sales/sync-account', { userId: mlAccountId, clientId, accountNickname, force, backfill: force, clientUid })
            .then(() => {
              const sseUrl = `${API_BASE_URL}/sales/sync-status/${clientId}?token=${encodeURIComponent(token.value)}&mlAccountId=${encodeURIComponent(mlAccountId)}`;
              eventSource = new window.EventSource(sseUrl);

              eventSource.onopen = () => {
                console.log(`[SSE] Conexão aberta para ${accountNickname} (${clientId})`);
                state.value.description = force ? "Conexão estabelecida. Iniciando sincronização completa..." : "Conexão estabelecida. Verificando atualizações...";
              };

              eventSource.onmessage = (event) => {
                const data = JSON.parse(event.data);
                state.value.progress = data.progress;
                state.value.description = data.message;
                state.value.type = data.type || 'info';
                
                // Atualiza contador de novas vendas se disponível
                if (data.newSalesCount !== undefined) {
                  state.value.newSalesCount = data.newSalesCount;
                }

                if (data.progress === 100) {
                  state.value.isSyncing = false;
                  state.value.title =
                    data.type === 'success' ? `Sucesso: ${accountNickname}` :
                    data.type === 'error'   ? `Erro: ${accountNickname}` :
                                              `Finalizado: ${accountNickname}`;

                  closeToast(8000);
                  if (eventSource) eventSource.close();

                  if (data.type === 'error') {
                    reject(new Error(data.message));
                  } else {
                    resolve();
                  }
                }
              };

              eventSource.onerror = (err) => {
                console.error("Erro no EventSource:", err);
                const errorMessage = 'A conexão com o servidor foi perdida durante a sincronização.';
                state.value = {
                  ...state.value,
                  progress: -1,
                  isSyncing: false,
                  title: `Erro de Conexão: ${accountNickname}`,
                  description: errorMessage,
                  type: 'error'
                };
                closeToast(8000);
                if (eventSource) eventSource.close();
                reject(new Error(errorMessage));
              };
            })
            .catch(error => {
              console.error("Erro ao iniciar a sincronização:", error);
              const errorMessage = error.message || 'Não foi possível iniciar o processo de sincronização.';
              state.value = {
                ...state.value,
                progress: -1,
                isSyncing: false,
                title: `Erro de Inicialização: ${accountNickname}`,
                description: errorMessage,
                type: 'error'
              };
              closeToast(8000);
              if (eventSource) eventSource.close();
              reject(new Error(errorMessage));
            });
        })
        .catch(error => {
          console.error("Erro ao verificar se deve forçar sincronização:", error);
          reject(new Error("Erro ao verificar status da sincronização"));
        });
    });
  };

  const enrichExistingSales = async (mlAccountId, accountNickname, clientUid = null) => {
    return new Promise((resolve, reject) => {
      if (state.value.isSyncing) {
        reject(new Error('Já existe uma operação em andamento'));
        return;
      }

      shouldForceSync(mlAccountId, clientUid)
        .then(() => {
          const clientId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          let eventSource = null;

          // Reset do estado
          state.value = {
            isSyncing: true,
            progress: 0,
            title: `Enriquecendo: ${accountNickname}`,
            description: 'Iniciando enriquecimento de dados...',
            type: 'info',
            isVisible: true,
            newSalesCount: 0
          };

          // Adiciona o clientUid no payload da requisição
          api.post('/sales/enrich-existing-sales', { userId: mlAccountId, clientId, accountNickname, clientUid })
            .then(() => {
              const sseUrl = `${API_BASE_URL}/sales/sync-status/${clientId}?token=${encodeURIComponent(token.value)}&mlAccountId=${encodeURIComponent(mlAccountId)}`;
              eventSource = new window.EventSource(sseUrl);

              eventSource.onopen = () => {
                console.log(`[SSE] Conexão aberta para enriquecimento ${accountNickname} (${clientId})`);
                state.value.description = "Conexão estabelecida. Iniciando enriquecimento...";
              };

              eventSource.onmessage = (event) => {
                const data = JSON.parse(event.data);
                state.value.progress = data.progress;
                state.value.description = data.message;
                state.value.type = data.type || 'info';
                
                // Atualiza contador de vendas enriquecidas se disponível
                if (data.enrichedCount !== undefined) {
                  state.value.newSalesCount = data.enrichedCount;
                }

                if (data.progress === 100) {
                  state.value.isSyncing = false;
                  state.value.title =
                    data.type === 'success' ? `Sucesso: ${accountNickname}` :
                    data.type === 'error'   ? `Erro: ${accountNickname}` :
                                              `Finalizado: ${accountNickname}`;

                  closeToast(8000);
                  if (eventSource) eventSource.close();

                  if (data.type === 'error') {
                    reject(new Error(data.message));
                  } else {
                    resolve();
                  }
                }
              };

              eventSource.onerror = (err) => {
                console.error(`[SSE ERROR] Enriquecimento ${accountNickname}:`, err);
                state.value.isSyncing = false;
                state.value.title = `Erro: ${accountNickname}`;
                state.value.description = 'Erro na conexão com o servidor';
                state.value.type = 'error';
                closeToast(8000);
                if (eventSource) eventSource.close();
                reject(new Error('Erro na conexão com o servidor'));
              };
            })
            .catch(err => {
              console.error(`[ENRICH ERROR] ${accountNickname}:`, err);
              state.value.isSyncing = false;
              state.value.title = `Erro: ${accountNickname}`;
              state.value.description = err.message || 'Erro desconhecido';
              state.value.type = 'error';
              closeToast(8000);
              reject(err);
            });
        })
        .catch(err => {
          console.error(`[ENRICH ERROR] ${accountNickname}:`, err);
          state.value.isSyncing = false;
          state.value.title = `Erro: ${accountNickname}`;
          state.value.description = err.message || 'Erro desconhecido';
          state.value.type = 'error';
          closeToast(8000);
          reject(err);
        });
    });
  };

  return {
    syncState: state,
    syncAccount,
    enrichExistingSales,
  };
}
