<template>
  <div>
    <button @click="openModal" class="connect-button">Conectar Conta Mercado Livre</button>
    <UniversalModal :title="modalTitle" :isOpen="isModalOpen" @close="closeModal">
      <div class="multi-account-info" style="margin-bottom: 1rem; background: #fffbe6; border: 1px solid #ffe066; border-radius: 8px; padding: 0.75rem; color: #7c6f00; font-size: 1rem;">
        <strong>Aviso:</strong> Você pode conectar múltiplas contas Mercado Livre!<br>
        Dica: Após conectar, deslogue do Mercado Livre para vincular outra conta.<br>
        <span style="font-size:0.95em;">(O Mercado Livre mantém a sessão ativa, então é necessário deslogar para conectar uma nova conta.)</span>
      </div>
      <p>Leia o aviso acima para entender como funcionar a conexão MercadoLivre/CyberDock</p>
      <button @click="connectMercadoLivre" class="action-button">Conectar</button>
    </UniversalModal>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import UniversalModal from './UniversalModal.vue';
import { useAuth } from '@/composables/useAuth';
import { API_BASE_URL } from '@/config.js';

const { loggedInUser } = useAuth();

const isModalOpen = ref(false);
const modalTitle = 'Conectar Conta Mercado Livre';

const openModal = () => { isModalOpen.value = true; };
const closeModal = () => { isModalOpen.value = false; };

const connectMercadoLivre = () => {
  if (!loggedInUser.value?.uid) return;
  const uid = loggedInUser.value.uid;

  // ❌ NÃO passar client_id nem redirect_uri aqui.
  const apiBase = API_BASE_URL.replace(/\/$/, '');
  window.location.href = `${apiBase}/ml/auth?uid=${encodeURIComponent(uid)}`;
};
</script>


<style scoped>
.connect-button {
  background-color: #3490dc;
  color: white;
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.action-button {
  background-color: #38a169;
  color: white;
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  margin-top: 1rem;
}
</style>
