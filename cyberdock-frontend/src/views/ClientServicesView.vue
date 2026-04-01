<template>
  <div class="client-services-wrapper">
    <div class="table-container">
      <div class="table-header">
        <h2 class="table-title">Serviços Contratados por Cliente</h2>
      </div>
      <div v-if="isLoadingUsers" class="feedback-cell">Carregando clientes...</div>
      <div v-else-if="users.length === 0" class="feedback-cell">Nenhum cliente encontrado.</div>
      <div v-else class="clients-list">
        <div v-for="user in users" :key="user.uid" class="client-card">
          <div class="client-info">
            <h3 class="client-email">{{ user.email }}</h3>
            <p class="client-id">ID: {{ user.uid }}</p>
          </div>
          <button @click="openContractModal(user)" class="btn btn-primary">Gerenciar Serviços</button>
        </div>
      </div>
    </div>

    <UniversalModal :title="`Gerenciar Serviços de ${currentUser?.email}`" :is-open="isContractModalOpen" @close="closeContractModal">
      <div class="contract-modal-content">
        <!-- Tabela de serviços já contratados -->
        <h4 class="modal-subtitle">Serviços Atuais</h4>
        <table class="services-table-modal">
          <thead>
            <tr>
              <th>Serviço</th>
              <th>Contratado em</th>
              <th>Volume/Qtd</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="isLoadingClientServices">
              <td colspan="4" class="feedback-cell">Carregando...</td>
            </tr>
            <tr v-else-if="clientServices.length === 0">
              <td colspan="4" class="feedback-cell">Nenhum serviço contratado.</td>
            </tr>
            <tr v-for="service in clientServices" :key="service.id">
              <td>{{ service.name }}</td>
              <td>{{ formatDate(service.startDate) }}</td>
              <td>{{ service.volume || 'N/A' }}</td>
              <td>
                <button @click="removeClientService(service.id)" class="btn-action delete" title="Remover Serviço">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        
        <!-- Formulário para adicionar novo serviço -->
        <h4 class="modal-subtitle">Adicionar Novo Serviço</h4>
        <form @submit.prevent="handleAddClientService" class="add-service-form">
          <div class="form-group">
            <label for="serviceId">Serviço</label>
            <select id="serviceId" v-model="newContract.serviceId" required>
              <option value="" disabled>Selecione um serviço</option>
              <option v-for="service in availableServices" :key="service.id" :value="service.id">
                {{ service.name }} ({{ service.price.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) }})
              </option>
            </select>
          </div>
          <div class="form-group">
            <label for="volume">Volume</label>
            <input id="volume" type="number" min="1" v-model.number="newContract.volume" required />
          </div>
          <div class="form-group">
            <label for="startDate">Data de Início</label>
            <input id="startDate" type="date" v-model="newContract.startDate" required />
          </div>
          <button type="submit" class="btn btn-primary add-btn">Adicionar</button>
        </form>
      </div>
    </UniversalModal>
  </div>
</template>

<script setup>
import { defineComponent, ref, reactive } from 'vue';
import { useUsers } from '@/composables/useUsers';
import { useServices } from '@/composables/useServices'; // Importação corrigida
import UniversalModal from '@/components/UniversalModal.vue';

const { users, isLoading: isLoadingUsers, fetchUsers } = useUsers();
const { 
    services: availableServices, 
    clientServices,
    isLoadingClientServices,
    addClientService, 
    fetchClientServices,
    removeClientService,
} = useServices();

const isContractModalOpen = ref(false);
const currentUser = ref(null);
const newContract = reactive({
  serviceId: '',
  volume: 1,
  startDate: new Date().toISOString().split('T')[0],
});

fetchUsers();

const openContractModal = (user) => {
  currentUser.value = user;
  fetchClientServices(user.uid);
  isContractModalOpen.value = true;
};

const closeContractModal = () => {
  isContractModalOpen.value = false;
  currentUser.value = null;
  clientServices.value = [];
};

const handleAddClientService = async () => {
    if (!currentUser.value) return;
    const service = availableServices.value.find(s => s.id === newContract.serviceId);
    if (!service) return;

    const contractData = {
        ...newContract,
        name: service.name,
        price: service.price,
    };
    
    await addClientService(currentUser.value.uid, contractData);
    // Reset form
    newContract.serviceId = '';
    newContract.volume = 1;
};

const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
};
</script>

<style scoped>
.client-services-wrapper { padding: 1rem; }
.table-container { background-color: #fff; border-radius: 0.75rem; box-shadow: 0 1px 3px 0 rgba(0,0,0,.1); }
.table-header { padding: 1.5rem; border-bottom: 1px solid #e5e7eb; }
.table-title { font-size: 1.25rem; font-weight: 600; margin: 0; }
.clients-list { display: flex; flex-direction: column; }
.client-card { display: flex; justify-content: space-between; align-items: center; padding: 1rem 1.5rem; border-bottom: 1px solid #e5e7eb; }
.client-card:last-child { border-bottom: none; }
.client-email { font-weight: 500; margin: 0; }
.client-id { font-size: 0.8rem; color: #6b7280; margin: 0.25rem 0 0; }
.feedback-cell { text-align: center; padding: 2rem; color: #6b7280; }
.modal-subtitle { font-size: 1.1rem; font-weight: 600; margin: 1.5rem 0 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid #e5e7eb; }
.services-table-modal { width: 100%; }
.add-service-form { display: grid; grid-template-columns: 2fr 1fr 1fr auto; gap: 1rem; align-items: flex-end; }
.form-group { display: flex; flex-direction: column; }
.form-group label { margin-bottom: 0.5rem; font-size: 0.875rem; }
.form-group input, .form-group select { padding: 0.6rem 0.8rem; border: 1px solid #d1d5db; border-radius: 0.5rem; }
.add-btn { align-self: end; }
.btn { padding: 0.6rem 1.2rem; font-size: 0.875rem; font-weight: 600; border-radius: 0.5rem; cursor: pointer; border: none; }
.btn-primary { background-color: #4f46e5; color: #fff; }
.btn-action.delete { color: #ef4444; background: none; border: none; cursor: pointer; }
</style>
