<template>
  <div class="dashboard-wrapper" ref="rootRef">
    <SidebarComponent />

    <div class="main-content">
      <TopbarComponent />

      <div class="dashboard-content">
        <div class="header" ref="headerRef">
          <div>
            <h1 class="dashboard-title">Gerenciar Contas</h1>
            <p class="dashboard-subtitle">Conecte e gerencie suas contas de e-commerce aqui.</p>
          </div>
          <div class="header-actions">
            <MercadoLivreConnect />
          </div>
        </div>

        <div class="accounts-list-wrapper">
          <div v-if="isLoading">
            <h2 class="list-title" ref="listTitleRef">Contas Conectadas <span class="platform-tag ml-tag">Mercado Livre</span></h2>
            <div class="accounts-grid">
              <div v-for="n in 2" :key="'ml-skel-' + n" class="skeleton-card">
                <div class="skeleton-header">
                  <div class="skeleton-line icon"></div>
                  <div class="skeleton-line title"></div>
                </div>
                <div class="skeleton-line text short"></div>
                <div class="skeleton-actions">
                  <div class="skeleton-line button"></div>
                </div>
              </div>
            </div>
          </div>

          <div v-else>
            <div v-if="accounts.mercadoLivre.length > 0" class="platform-section">
              <h2 class="list-title" ref="listTitleRef">
                Contas Conectadas <span class="platform-tag ml-tag">Mercado Livre</span>
              </h2>

              <div class="accounts-grid" ref="mlGrid">
                <div v-for="account in accounts.mercadoLivre" :key="account.user_id" class="account-card" @mouseenter="hoverCard($event, true)" @mouseleave="hoverCard($event, false)">
                  <div class="account-card-header">
                    <div class="account-title">
                      <span class="account-nickname">{{ account.nickname }}</span>
                    </div>
                    <div class="status-display" :data-status="account.status">
                      <span class="status-dot" :class="account.status"></span>
                      <span class="status-text">{{ getStatusText(account.status) }}</span>
                    </div>
                  </div>

                  <p class="account-id">ID: {{ account.user_id }}</p>

                  <div class="account-actions">
                    <button
                      v-if="userRole === 'master'"
                      @mousedown="press"
                      @click="requestDelete(account)"
                      class="action-btn delete-btn"
                      aria-label="Excluir Conta"
                      title="Excluir Conta"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M4 7l16 0" /><path d="M10 11l0 6" /><path d="M14 11l0 6" /><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12" /><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3" /></svg>
                    </button>
                  </div>

                  <button @mousedown="press" @click="toggleDetails(account)" class="details-toggle">
                    {{ account.isExpanded ? 'Ocultar detalhes' : 'Mostrar detalhes' }}
                  </button>

                  <Transition @enter="onEnter" @leave="onLeave">
                    <div v-if="account.isExpanded" class="details-content">
                      <div class="token-info">
                        <label>Access Token</label>
                        <div class="token-value">
                          <code>{{ account.showAccessToken ? account.access_token : maskToken(account.access_token) }}</code>
                          <button @mousedown="press" @click="account.showAccessToken = !account.showAccessToken" class="copy-btn" aria-label="Mostrar/Ocultar Access Token" title="Mostrar/Ocultar">
                            <svg v-if="!account.showAccessToken" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>
                            <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 9.9 4.2 4.2" /><path d="m14.1 14.1 5.7 5.7" /><path d="M2 12s-3 7-10 7a9.84 9.84 0 0 1 5 1.4" /><path d="M22 12s-3 7-10 7a9.84 9.84 0 0 1-5-1.4" /><path d="M14.1 9.9a3 3 0 0 1-4.2 4.2" /></svg>
                          </button>
                        </div>
                      </div>

                      <div class="token-info" v-if="account.refresh_token">
                        <label>Refresh Token</label>
                        <div class="token-value">
                          <code>{{ account.showRefreshToken ? account.refresh_token : maskToken(account.refresh_token) }}</code>
                          <button @mousedown="press" @click="account.showRefreshToken = !account.showRefreshToken" class="copy-btn" aria-label="Mostrar/Ocultar Refresh Token" title="Mostrar/Ocultar">
                            <svg v-if="!account.showRefreshToken" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>
                            <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 9.9 4.2 4.2" /><path d="m14.1 14.1 5.7 5.7" /><path d="M2 12s-3 7-10 7a9.84 9.84 0 0 1 5 1.4" /><path d="M22 12s-3 7-10 7a9.84 9.84 0 0 1-5-1.4" /><path d="M14.1 9.9a3 3 0 0 1-4.2 4.2" /></svg>
                          </button>
                        </div>
                      </div>

                      <div class="token-info">
                        <label>Conectado em</label>
                        <div class="token-value">
                          <code>{{ formatDate(account.connected_at) }}</code>
                        </div>
                      </div>
                      <div class="token-info">
                        <label>Expira em</label>
                        <div class="token-value">
                          <code>{{ formatExpiration(account.connected_at, account.expires_in) }}</code>
                        </div>
                      </div>
                    </div>
                  </Transition>
                </div>
              </div>
            </div>

            <div v-if="!isLoading && accounts.mercadoLivre.length === 0" class="no-accounts">
              <p>Nenhuma conta conectada ainda.</p>
              <span>Clique no botão acima para conectar sua primeira conta.</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <Transition name="modal-fade">
    <div v-if="accountToDelete" class="modal-overlay" @click.self="cancelDelete">
      <div class="modal-panel">
        <div class="modal-header">
          <h3>Confirmar Exclusão</h3>
          <button @click="cancelDelete" class="close-btn" aria-label="Fechar modal">&times;</button>
        </div>
        <div class="modal-body">
          <p>Você tem certeza que deseja excluir a conta "<strong>{{ accountToDelete.nickname }}</strong>"? Esta ação não pode ser desfeita.</p>
        </div>
        <div class="modal-footer">
          <button @click="cancelDelete" class="btn-cancel">Cancelar</button>
          <button @click="confirmDelete" class="btn-confirm-delete">Sim, Excluir</button>
        </div>
      </div>
    </div>
  </Transition>

  <!-- Toast Notification for Sync Status -->
  <ToastNotification 
    :is-visible="syncState.isVisible" 
    :title="syncState.title"
    :description="syncState.description" 
    :progress="syncState.progress" 
    :type="syncState.type" 
  />
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import gsap from 'gsap';

import SidebarComponent from '../components/SidebarComponent.vue';
import TopbarComponent from '../components/TopbarComponent.vue';
import MercadoLivreConnect from '../components/MercadoLivreConnect.vue';
import ToastNotification from '../components/ToastNotification.vue';

import { useAuth } from '@/composables/useAuth';
import { useApi } from '@/composables/useApi';
import { useSyncManager } from '@/composables/useSyncManager';

const { user, userRole, isAuthReady, fetchMercadoLivreAccounts: fetchAccountsFromAuth } = useAuth();
const api = useApi();
const { syncState } = useSyncManager();
const route = useRoute();
const router = useRouter();



const rootRef = ref(null);
const headerRef = ref(null);
const listTitleRef = ref(null);
const mlGrid = ref(null);
let ctx;

const accounts = ref({ mercadoLivre: [] });
const isLoading = ref(true);

const accountToDelete = ref(null);
const notification = ref({ show: false, title: '', message: '' });

const showSimpleNotification = (title, message) => {
  notification.value = { show: true, title, message };
  setTimeout(() => {
    notification.value.show = false;
  }, 3000);
};

const addExtraProperties = (acc) => ({
  ...acc,
  isExpanded: false,
  showAccessToken: false,
  showRefreshToken: false,
});

const fetchAllAccounts = async () => {
  isLoading.value = true;
  try {
    const mlData = await fetchAccountsFromAuth();
    if (mlData && mlData.error) {
      showSimpleNotification('Erro', mlData.error);
      accounts.value.mercadoLivre = [];
    } else {
      const processedMlData = mlData.map((acc) => {
        let finalAccount = { ...acc };
        if (finalAccount.status === 'active' && finalAccount.expires_in && finalAccount.connected_at) {
          const expirationTime = new Date(finalAccount.connected_at).getTime() + finalAccount.expires_in * 1000;
          const threeDays = 3 * 24 * 60 * 60 * 1000;
          const isExpiringSoon = expirationTime - Date.now() < threeDays;
          if (isExpiringSoon) finalAccount.status = 'attention';
        }
        return addExtraProperties(finalAccount);
      });
      accounts.value.mercadoLivre = processedMlData;
    }
  } finally {
    isLoading.value = false;
  }
};

const toggleDetails = (account) => {
  account.isExpanded = !account.isExpanded;
};

const maskToken = (token) => {
  if (!token) return '';
  return `${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
};

const formatDate = (timestamp) => {
  if (!timestamp) return 'N/A';
  const date = new Date(timestamp);
  return date.toLocaleDateString('pt-BR') + ' ' + date.toLocaleTimeString('pt-BR');
};

const formatExpiration = (connectedAt, expiresIn) => {
  if (!connectedAt || !expiresIn) return 'N/A';
  const expirationTime = new Date(connectedAt).getTime() + expiresIn * 1000;
  const date = new Date(expirationTime);
  return date.toLocaleDateString('pt-BR') + ' ' + date.toLocaleTimeString('pt-BR');
};

const requestDelete = (account) => {
  if (userRole.value !== 'master') {
    showSimpleNotification('Acesso Negado', 'Você não tem permissão para excluir contas.');
    return;
  }
  accountToDelete.value = account;
};

const cancelDelete = () => {
  accountToDelete.value = null;
};

const confirmDelete = async () => {
  if (userRole.value !== 'master' || !accountToDelete.value) {
    showSimpleNotification('Acesso Negado', 'Ação não permitida.');
    cancelDelete();
    return;
  }

  const account = accountToDelete.value;
  const id = account.user_id;

  try {
    await api.delete(`/ml/contas/${id}`);
    showSimpleNotification('Sucesso!', `A conta "${account.nickname}" foi excluída.`);
    await fetchAllAccounts();
  } catch (error) {
    const errorMessage = error.data?.error || 'Não foi possível excluir a conta.';
    showSimpleNotification('Erro', errorMessage);
  } finally {
    cancelDelete();
  }
};

const onEnter = (el, done) => {
  gsap.fromTo(
    el,
    { height: 0, opacity: 0, marginTop: 0 },
    { height: 'auto', opacity: 1, marginTop: '1rem', duration: 0.28, ease: 'power2.out', onComplete: done }
  );
};

const onLeave = (el, done) => {
  gsap.to(el, { height: 0, opacity: 0, marginTop: 0, duration: 0.24, ease: 'power1.inOut', onComplete: done });
};

const press = (e) => {
  gsap.fromTo(
    e.currentTarget,
    { scale: 1 },
    { scale: 0.96, duration: 0.08, yoyo: true, repeat: 1, ease: 'power1.out' }
  );
};

const hoverCard = (e, entering) => {
  gsap.to(e.currentTarget, {
    y: entering ? -2 : 0,
    boxShadow: entering
      ? '0 0 0 1px rgba(15, 23, 42, 0.06), 0 6px 18px rgba(2,6,23,0.06)'
      : '0 0 0 1px var(--border), 0 0 0 rgba(0,0,0,0)'
  });
};



// const handleSyncAllAccounts = async () => {
//   if (syncState.value.isSyncing) return;
  
//   if (!accounts.value.mercadoLivre || accounts.value.mercadoLivre.length === 0) {
//     showSimpleNotification('Atenção', 'Nenhuma conta do Mercado Livre conectada para sincronizar.');
//     return;
//   }


//   let successCount = 0;
//   let errorCount = 0;
//   const totalAccounts = accounts.value.mercadoLivre.length;

//   try {
//     for (const account of accounts.value.mercadoLivre) {
//       try {
//         await syncAccount(account.user_id, account.nickname);
//         successCount++;
//       } catch (err) {
//         errorCount++;
//         console.error(`Falha ao sincronizar a conta ${account.nickname} (${account.user_id}):`, err);
//       }
//     }

//     if (totalAccounts > 1) {
//       const message = `${successCount} de ${totalAccounts} contas sincronizadas com sucesso. ${errorCount > 0 ? `${errorCount} falharam.` : ''}`;
//       showSimpleNotification(
//         'Sincronização Finalizada', 
//         message
//       );
//     }
//   } catch (err) {
//     console.error('Falha geral ao sincronizar contas:', err);
//     showSimpleNotification('Erro Geral', err.message);
//   }
// };

const getStatusText = (status) => {
  const map = { active: 'Ativa', attention: 'Atenção', error: 'Erro' };
  return map[status] || 'Inativa';
};

onMounted(() => {
  ctx = gsap.context(() => {
    if (headerRef.value) {
      gsap.from(headerRef.value, { opacity: 0, y: -12, duration: 0.45, ease: 'power2.out' });
    }
    if (listTitleRef.value) {
      gsap.from(listTitleRef.value, { opacity: 0, y: 8, duration: 0.35, delay: 0.05 });
    }
  }, rootRef);

  watch(
    isAuthReady,
    async (ready) => {
      if (!ready) return;
      if (user.value) {
        await fetchAllAccounts();
        if (route.query.success || route.query.error) {
          const message = route.query.success
            ? decodeURIComponent(route.query.success)
            : decodeURIComponent(route.query.error);
          const title = route.query.success ? 'Sucesso!' : 'Ocorreu um Erro';
          showSimpleNotification(title, message);
          router.replace({ query: {} });
        }
      } else {
        accounts.value.mercadoLivre = [];
        isLoading.value = false;
      }
    },
    { immediate: true }
  );

  watch(isLoading, async (loading) => {
    if (!loading) {
      await nextTick();
      const cards = mlGrid.value?.querySelectorAll('.account-card');
      if (cards?.length) {
        gsap.from(cards, { opacity: 0, y: 12, duration: 0.4, stagger: 0.06, ease: 'power2.out' });
      }
    }
  });

  // Watch for sync completion to refresh accounts
  watch(() => syncState.value.isSyncing, (isSyncing, wasSyncing) => {
    if (wasSyncing && !isSyncing && syncState.value.progress === 100 && syncState.value.type !== 'error') {
      fetchAllAccounts();
    }
  });
});

onUnmounted(() => {
  if (ctx) ctx.revert();
});
</script>

<style scoped>
.dashboard-wrapper {
  --bg: #f3f4f6;
  --surface: #ffffff;
  --text: #0f172a;
  --muted: #475569;
  --subtle: #64748b;
  --border: #e5e7eb;
  --ring: rgba(59, 130, 246, 0.12);
  --brand: #2563eb;
  --success: #16a34a;
  --warn: #f59e0b;
  --danger: #ef4444;
  display: flex;
  min-height: 100vh;
  font-family: 'Inter', system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji';
  background-color: var(--bg);
  color: var(--text);
}
.main-content { flex: 1; display: flex; flex-direction: column; }
.dashboard-content { flex: 1; padding: 1.75rem 2rem 2.25rem; }
.header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-bottom: 2rem; }
.header-actions { display: flex; gap: 0.75rem; align-items: center; }

.btn {
  padding: 0.6rem 1.2rem;
  font-size: 0.875rem;
  font-weight: 600;
  border: none;
  border-radius: 0.5rem;
  cursor: pointer;
  transition: all 0.2s;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}

.btn-primary {
  background-color: #4f46e5;
  color: #fff;
}

.btn-primary:hover:not(:disabled) {
  background-color: #4338ca;
}

.btn-secondary {
  background-color: #6b7280;
  color: #fff;
}

.btn-secondary:hover:not(:disabled) {
  background-color: #4b5563;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.sync-btn {
  position: relative;
}

.sync-spinner {
  animation: spin 1.5s linear infinite;
}

.mode-indicator {
  margin-left: 0.25rem;
  opacity: 0.7;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
.dashboard-title { font-size: 1.75rem; font-weight: 700; letter-spacing: -0.01em; color: var(--text); margin: 0; }
.dashboard-subtitle { margin-top: 0.3rem; font-size: 0.95rem; color: var(--subtle); }
.list-title { font-size: 1.1rem; font-weight: 600; color: #1f2937; margin: 0 0 1rem; display: flex; align-items: center; gap: 0.6rem; }
.accounts-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1rem; }
.account-card { background: var(--surface); border-radius: 14px; border: 1px solid var(--border); padding: 1.25rem; box-shadow: 0 0 0 1px var(--border); transition: box-shadow 180ms, transform 180ms; will-change: transform; }
.account-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.35rem; }
.account-title { display: flex; align-items: center; gap: 0.5rem; font-weight: 600; color: #111827; }
.account-nickname { font-weight: 600; color: #111827; }
.account-id { font-size: 0.85rem; color: #6b7280; margin-bottom: 0.9rem; }
.account-actions { display: flex; gap: 0.5rem; margin-bottom: 0.8rem; }
.action-btn { height: 36px; width: 36px; display: inline-flex; align-items: center; justify-content: center; background: #fff; border: 1px solid var(--border); border-radius: 10px; color: #334155; cursor: pointer; transition: background 140ms, border-color 140ms, color 140ms, box-shadow 140ms; }
.action-btn:hover:not(:disabled) { background: #f8fafc; border-color: #dbe1ea; color: #111827; box-shadow: 0 0 0 4px var(--ring); }
.action-btn:focus-visible { outline: none; box-shadow: 0 0 0 4px var(--ring); }
.action-btn:disabled { cursor: not-allowed; opacity: 0.55; }
.action-btn.delete-btn:hover { background: #fff7f7; border-color: #fde2e2; color: #b91c1c; }
.details-toggle { background: none; border: none; color: var(--brand); font-size: 0.9rem; font-weight: 500; cursor: pointer; padding: 0; margin-top: auto; }
.details-toggle:hover { text-decoration: underline; }
.details-toggle:focus-visible { outline: none; box-shadow: 0 0 0 4px var(--ring); border-radius: 6px; }
.details-content { overflow: hidden; border-top: 1px solid var(--border); }
.token-info { margin-top: 0.9rem; }
.token-info label { display: block; font-size: 0.75rem; font-weight: 600; color: #374151; margin-bottom: 0.25rem; }
.token-value { display: flex; align-items: center; gap: 0.5rem; background: #f8fafc; padding: 0.55rem 0.75rem; border-radius: 8px; border: 1px solid #eef2f7; }
.token-value code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; font-size: 0.78rem; color: #334155; word-break: break-all; flex: 1; }
.copy-btn { background: none; border: none; cursor: pointer; color: #64748b; padding: 2px; border-radius: 8px; }
.copy-btn:hover { color: #111827; box-shadow: 0 0 0 4px var(--ring); }
.status-display { display: inline-flex; align-items: center; gap: 0.45rem; padding: 0.25rem 0.6rem; border-radius: 9999px; background: #f8fafc; border: 1px solid var(--border); }
.status-text { font-size: 0.78rem; font-weight: 600; line-height: 1; color: #334155; }
.status-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; animation: pulse-dot 2.5s infinite cubic-bezier(0.4, 0, 0.6, 1); }
.status-dot.active { background-color: var(--success); }
.status-dot.attention { background-color: var(--warn); }
.status-dot.error { background-color: var(--danger); }
.platform-tag { font-size: 0.78rem; font-weight: 600; padding: 0.22rem 0.6rem; border-radius: 9999px; border: 1px solid #f5e6a3; background: #fff7bf; color: #3a3a3a; }
.skeleton-card { background-color: var(--surface); padding: 1.25rem; border-radius: 14px; border: 1px solid var(--border); }
.skeleton-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.8rem; }
.skeleton-line { position: relative; overflow: hidden; background: linear-gradient(90deg, rgba(2,6,23,0.06) 25%, rgba(2,6,23,0.08) 37%, rgba(2,6,23,0.06) 63%); background-size: 400% 100%; animation: shimmer 1.4s infinite; border-radius: 8px; }
.skeleton-line.icon { width: 36px; height: 36px; border-radius: 10px; }
.skeleton-line.title { height: 16px; flex: 1; }
.skeleton-line.text { height: 12px; margin: 8px 0 14px; }
.skeleton-line.text.short { width: 65%; }
.skeleton-actions { display: flex; gap: 0.5rem; }
.skeleton-line.button { width: 36px; height: 36px; border-radius: 10px; }
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
.no-accounts { display: grid; place-items: center; padding: 2.5rem 1rem; text-align: center; color: #475569; border: 2px dashed var(--border); background: #fff; border-radius: 14px; }

.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.modal-panel {
  background: white;
  border-radius: 12px;
  box-shadow: 0 5px 15px rgba(0,0,0,0.3);
  width: 90%;
  max-width: 450px;
  overflow: hidden;
}
.modal-header {
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--border);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.modal-header h3 {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
}
.close-btn {
  background: none;
  border: none;
  font-size: 2rem;
  font-weight: 300;
  line-height: 1;
  color: var(--muted);
  cursor: pointer;
}
.modal-body {
  padding: 1.5rem;
  color: var(--muted);
}
.modal-body p strong {
  color: var(--text);
  font-weight: 600;
}
.modal-footer {
  padding: 1rem 1.5rem;
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  background-color: #f9fafb;
}
.modal-footer button {
  border: none;
  padding: 0.65rem 1.25rem;
  border-radius: 8px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.2s;
}
.btn-cancel {
  background-color: #fff;
  border: 1px solid var(--border);
  color: var(--text);
}
.btn-cancel:hover {
  background-color: #f8fafc;
}
.btn-confirm-delete {
  background-color: #fff;
  color: #151515;
}
.btn-confirm-delete:hover {
  background-color: #dc2626;
  color: white;
}
.modal-fade-enter-active, .modal-fade-leave-active {
  transition: opacity 0.3s ease;
}
.modal-fade-enter-from, .modal-fade-leave-to {
  opacity: 0;
}
.modal-fade-enter-active .modal-panel, .modal-fade-leave-active .modal-panel {
  transition: transform 0.3s ease;
}
.modal-fade-enter-from .modal-panel, .modal-fade-leave-to .modal-panel {
  transform: scale(0.95);
}

@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}

/* Badge de novas vendas */
.new-sales-badge {
  position: absolute;
  top: -8px;
  right: -8px;
  background: #ef4444;
  color: white;
  border-radius: 50%;
  min-width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 600;
  border: 2px solid white;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.1);
  }
  100% {
    transform: scale(1);
  }
}

/* Posicionamento relativo para o botão de sincronização */
.sync-btn {
  position: relative;
}
</style>
