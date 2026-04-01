<template>
  <div class="services-view-wrapper">
    <div class="table-container">
      <div class="table-header">
        <h2 class="table-title">Catálogo de Produtos e Serviços</h2>
        <button @click="openServiceModal()" class="btn btn-primary">Adicionar Novo Item</button>
      </div>
      <table class="services-table">
        <thead>
          <tr>
            <th>Nome do Item</th>
            <th>Preço (R$)</th>
            <th>Ações</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="isLoadingServices">
            <td colspan="3" class="feedback-cell">Carregando catálogo...</td>
          </tr>
          <tr v-else-if="services.length === 0">
            <td colspan="3" class="feedback-cell">Nenhum item cadastrado.</td>
          </tr>
          <tr v-for="service in services" :key="service.id">
            <td data-label="Nome do Item">{{ service.name }}</td>
            <td data-label="Preço (R$)">{{ formatCurrency(service.price) }}</td>
            <td data-label="Ações" class="actions-cell">
              <button @click="openServiceModal(service)" class="btn-action edit" title="Editar">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
              </button>
              <button @click="openDeleteServiceModal(service)" class="btn-action delete" title="Excluir">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Modal para Adicionar/Editar Serviço -->
    <UniversalModal :title="isEditingService ? 'Editar Item' : 'Adicionar Novo Item'" :is-open="isServiceModalOpen" @close="closeServiceModal">
      <form @submit.prevent="handleSaveService" class="service-form">
        <div class="form-group">
          <label for="service-name">Nome do Item</label>
          <input id="service-name" type="text" v-model="currentService.name" required>
        </div>
        <div class="form-group">
          <label for="service-price">Preço (R$)</label>
          <input id="service-price" type="number" v-model.number="currentService.price" min="0" step="0.01" required>
        </div>
      </form>
      <div class="modal-actions">
        <button @click="closeServiceModal" type="button" class="btn btn-secondary">Cancelar</button>
        <button @click="handleSaveService" type="button" class="btn btn-primary">Salvar</button>
      </div>
    </UniversalModal>

    <!-- Modal de Confirmação de Exclusão -->
    <UniversalModal title="Confirmar Exclusão" :is-open="isDeleteServiceModalOpen" @close="closeDeleteServiceModal">
      <div class="confirm-delete-content" v-if="serviceToDelete">
        <p>Tem certeza que deseja excluir o item <strong>"{{ serviceToDelete.name }}"</strong>?</p>
        <p class="warning-text">Esta ação não pode ser desfeita.</p>
      </div>
      <div class="modal-actions">
        <button @click="closeDeleteServiceModal" class="btn btn-secondary">Cancelar</button>
        <button @click="handleConfirmDeleteService" class="btn btn-danger">Confirmar Exclusão</button>
      </div>
    </UniversalModal>
  </div>
</template>

<script setup>
import UniversalModal from '@/components/UniversalModal.vue';
import { useServices } from '@/composables/useServices.js';
import { onMounted } from 'vue';

const {
  services,
  isLoadingServices,
  isEditingService,
  currentService,
  isServiceModalOpen,
  isDeleteServiceModalOpen,
  serviceToDelete,
  openServiceModal,
  closeServiceModal,
  handleSaveService,
  openDeleteServiceModal,
  closeDeleteServiceModal,
  handleConfirmDeleteService,
  formatCurrency,
  fetchServices
} = useServices();

onMounted(() => {
    fetchServices();
});

</script>

<style scoped>
.services-view-wrapper { padding: 1rem; font-family: 'Inter', sans-serif; }
.table-container { background-color: #ffffff; border-radius: 0.75rem; box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1); overflow-x: auto; }
.table-header { display: flex; justify-content: space-between; align-items: center; padding: 1.5rem; border-bottom: 1px solid #e5e7eb; }
.table-title { font-size: 1.25rem; font-weight: 600; color: #111827; margin: 0; }
.services-table { width: 100%; border-collapse: collapse; }
.services-table th, .services-table td { padding: 1rem 1.5rem; border-bottom: 1px solid #e5e7eb; text-align: left; }
.services-table thead th { font-size: 0.75rem; font-weight: 600; color: #6b7280; text-transform: uppercase; }
.feedback-cell { text-align: center; padding: 3rem; color: #6b7280; }
.actions-cell { display: flex; gap: 0.75rem; }
.btn-action { background: transparent; border: none; cursor: pointer; padding: 0.25rem; border-radius: 50%; transition: background-color 0.2s; }
.btn-action.edit { color: #2563eb; }
.btn-action.edit:hover { background-color: #dbeafe; }
.btn-action.delete { color: #ef4444; }
.btn-action.delete:hover { background-color: #fee2e2; }
.service-form { display: flex; flex-direction: column; gap: 1.25rem; padding: 0.5rem; }
.form-group { display: flex; flex-direction: column; }
.form-group label { margin-bottom: 0.5rem; font-weight: 500; font-size: 0.875rem; color: #374151; }
.form-group input { padding: 0.6rem 0.8rem; border: 1px solid #d1d5db; border-radius: 0.5rem; font-size: 0.875rem; transition: border-color 0.2s, box-shadow 0.2s; }
.form-group input:focus { outline: none; border-color: #4f46e5; box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.2); }
.modal-actions { display: flex; justify-content: flex-end; gap: 0.75rem; margin-top: 1.5rem; padding: 0 0.5rem 0.5rem; }
.btn { padding: 0.6rem 1.2rem; font-size: 0.875rem; font-weight: 600; border-radius: 0.5rem; cursor: pointer; border: none; transition: all 0.2s; }
.btn-primary { background-color: #4f46e5; color: #fff; }
.btn-primary:hover { background-color: #4338ca; }
.btn-secondary { background-color: #e5e7eb; color: #374151; }
.btn-secondary:hover { background-color: #d1d5db; }
.btn-danger { background-color: #ef4444; color: #fff; }
.btn-danger:hover { background-color: #dc2626; }
.confirm-delete-content p { margin: 0 0 0.5rem 0; }
.warning-text { font-size: 0.875rem; color: #9ca3af; }
@media (max-width: 768px) {
  .services-table thead { display: none; }
  .services-table tr { display: block; margin-bottom: 1rem; border: 1px solid #e5e7eb; border-radius: 0.5rem; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05); padding: 0.5rem; }
  .services-table td { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #f3f4f6; padding: 0.75rem 0.5rem; text-align: right; white-space: normal; }
  .services-table td:before { content: attr(data-label); font-weight: 600; color: #4b5563; text-align: left; padding-right: 1rem; }
  .services-table td:last-child { border-bottom: none; }
  .actions-cell { justify-content: flex-end; }
}
</style>
