<template>
  <div class="users-wrapper">
    <SidebarComponent />
    <div class="main-content">
      <TopbarComponent />
      <div class="content-area">
        <div class="header">
          <div>
            <h1 class="title">Administrar Usuários</h1>
            <p class="subtitle">Gerencie as permissões e os dados dos usuários do sistema.</p>
          </div>
          <div class="header-actions">
            <button @click="handleSyncAllAccounts" :disabled="syncState.isSyncing || isLoadingUsers"
              :class="['btn', 'sync-btn', 'btn-primary']" 
              title="Clique para sincronizar todas as contas">
              <svg v-if="syncState.isSyncing" class="sync-spinner"
                  xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24"
                  fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
                  stroke-linejoin="round">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              <span v-if="syncState.isSyncing">Sincronizando...</span>
              <span v-else>Sincronizar Todas as Contas</span>
              
              <span v-if="syncState.newSalesCount > 0" class="new-sales-badge">
                  {{ syncState.newSalesCount }}
              </span>
            </button>
             <!-- Botão para histórico geral -->
             <button @click="setView('history')" class="btn btn-secondary">
              Histórico de Serviços
            </button>
          </div>
        </div>

        <div v-if="currentView !== 'users' && selectedUser" class="user-context-panel">
          <div class="user-context-header">
            <button @click="setView('users')" class="btn-back" title="Voltar para lista">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
            </button>
            <div class="user-context-info">
              <span class="user-context-name">{{ selectedUser.name || selectedUser.mlNickname || selectedUser.email }}</span>
              <span class="user-context-email" v-if="selectedUser.name || selectedUser.mlNickname">{{ selectedUser.email }}</span>
            </div>
          </div>
          <nav class="user-tabs">
            <button 
              :class="['user-tab', { active: currentView === 'sales' }]" 
              @click="switchUserView('sales')"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>
              Vendas
            </button>
            <button 
              :class="['user-tab', { active: currentView === 'storage' }]" 
              @click="switchUserView('storage')"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path></svg>
              Armazenamento
            </button>
            <button 
              :class="['user-tab', { active: currentView === 'billing' }]" 
              @click="switchUserView('billing')"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"></rect><line x1="1" y1="10" x2="23" y2="10"></line></svg>
              Cobrança
            </button>
          </nav>
        </div>
        <div v-else-if="currentView !== 'users'" class="breadcrumbs">
          <button @click="setView('users')" class="breadcrumb-link">Todos os Usuários</button>
          <span class="breadcrumb-separator">/</span>
          <span class="breadcrumb-active">{{ breadcrumbTitle }}</span>
        </div>

        <!-- Visão: Lista de Usuários e Cadastros Globais -->
        <div v-if="currentView === 'users'">
          <!-- PAINEL DE CADASTROS GLOBAIS -->
          <div class="global-settings-panel">
            <h3 class="panel-title">Cadastros Globais (Replicáveis)</h3>
            <div class="panel-buttons">
              <button @click="openServiceCatalogueModal" class="btn-global">
                <div class="btn-icon bg-indigo"><svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg></div>
                <div class="btn-info">
                  <span class="btn-title">Catálogo de Serviços</span>
                  <span class="btn-desc">Planos e limites para clientes</span>
                </div>
              </button>
              
              <button @click="openStatusManagerModal" class="btn-global">
                <div class="btn-icon bg-emerald"><svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg></div>
                <div class="btn-info">
                  <span class="btn-title">Status de Vendas</span>
                  <span class="btn-desc">Etiquetas globais para pedidos</span>
                </div>
              </button>

              <button @click="openPackageTypesModal" class="btn-global">
                <div class="btn-icon bg-amber"><svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg></div>
                <div class="btn-info">
                  <span class="btn-title">Tipos de Pacote</span>
                  <span class="btn-desc">Custo de expedição e embalagens</span>
                </div>
              </button>
            </div>
          </div>

          <div class="table-controls">
            <div class="search-wrapper">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="search-icon"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
              <input type="text" v-model="userSearchQuery" placeholder="Buscar por nome ou email..." class="search-input" />
            </div>
            <div class="status-filter-wrapper">
              <label class="filter-label">Status:</label>
              <select v-model="userStatusFilter" class="status-filter-select">
                <option value="all">Todos</option>
                <option value="active">Ativos</option>
                <option value="inactive">Inativos</option>
              </select>
            </div>
          </div>

          <div class="table-container" ref="tableContainer">
            <div class="table-wrapper">
               <template v-if="isLoadingUsers">
                <table class="users-table">
                  <thead>
                    <tr>
                      <th>Usuário</th>
                      <th>Nome</th>
                      <th>Permissão</th>
                      <th>Serviços Contratados</th>
                      <th>Data de Criação</th>
                      <th>Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="n in 8" :key="'sk-'+n" class="is-skeleton">
                      <td><div class="sk sk-text" style="width: 60%"></div></td>
                      <td><div class="sk sk-text" style="width: 50%"></div></td>
                      <td><div class="sk sk-pill" style="width: 60px"></div></td>
                      <td><div class="sk sk-pill" style="width: 80px"></div></td>
                      <td><div class="sk sk-btn" style="width: 90px"></div></td>
                      <td><div class="sk sk-text" style="width: 40%"></div></td>
                      <td><div class="sk sk-pill" style="width: 72px"></div></td>
                    </tr>
                  </tbody>
                </table>
              </template>

              <div v-else-if="usersError" class="feedback-state error-state"><p>{{ usersError }}</p></div>
              <div v-else-if="filteredUsers.length === 0" class="feedback-state empty-state"><h3>Nenhum usuário encontrado</h3></div>
              
              <div v-else>
                <table class="users-table" aria-live="polite">
                  <thead>
                    <tr>
                      <th>Usuário</th>
                      <th>Nome</th>
                      <th>Status</th>
                      <th>Permissão</th>
                      <th>Serviços Contratados</th>
                      <th>Data de Criação</th>
                      <th>Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="user in paginatedUsers"
                      :key="user.uid"
                      class="row-anim"
                      :class="{ 'row-inactive': !user.active }"
                    >
                      <td data-label="Usuário">{{ user.mlNickname || user.email }}</td>
                      <td data-label="Nome">{{ user.name || '—' }}</td>
                      <td data-label="Status">
                        <span :class="['status-pill', user.active ? 'pill-active' : 'pill-inactive']">
                          {{ user.active ? 'Ativo' : 'Inativo' }}
                        </span>
                      </td>
                      <td data-label="Permissão">
                        <select
                          class="role-select"
                          :value="user.role"
                          @change="handleRoleChange(user, $event.target.value)"
                        >
                          <option value="cliente">Cliente</option>
                          <option value="master">Master</option>
                        </select>
                      </td>
                      <td data-label="Serviços Contratados">
                        <button @click="openContractModal(user)" class="btn btn-secondary btn-sm">Gerenciar</button>
                      </td>
                      <td data-label="Data de Criação">{{ formatDate(user.createdAt) }}</td>
                      <td data-label="Ações" class="actions-cell">
                        <button
                          class="actions-button"
                          @click.stop="toggleActionsMenu(user, $event)"
                          @keydown.enter.stop="toggleActionsMenu(user, $event)"
                          aria-haspopup="menu"
                          :aria-expanded="!!activeMenu.user && activeMenu.user.uid === user.uid"
                        >
                          Ações
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="pagination-controls" v-if="totalPages > 1">
              <button @click="prevPage" :disabled="currentPage === 1">Anterior</button>
              <span>Página {{ currentPage }} de {{ totalPages }}</span>
              <button @click="nextPage" :disabled="currentPage === totalPages">Próximo</button>
            </div>
          </div>
        </div>

        <!-- Outras Visões (Renderização Condicional) -->
        <UserSalesTable v-if="currentView === 'sales' && selectedUser" :user-id="selectedUser.uid" />
        <MasterStorageView v-if="currentView === 'storage' && selectedUser && isMaster" :user-id="selectedUser.uid" />
        <UserStorageView v-if="currentView === 'storage' && selectedUser && !isMaster" :user-id="selectedUser.uid" />
        <MasterResumoCobranca v-if="currentView === 'billing'" :user-id="selectedUser.uid" />
        <ServiceHistory v-if="currentView === 'history'" />
        <!-- Adicionando o novo componente para a visão geral de vendas do master -->
        <MasterSalesTable v-if="currentView === 'master_sales'" />


        <!-- Dropdown de Ações -->
        <div
          v-if="activeMenu.user"
          class="actions-dropdown-floating"
          :style="activeMenu.style"
          ref="actionsDropdown"
        >
          <a @click="openEditNameModal(activeMenu.user)">Editar Nome</a>
          <a @click="editUserSales(activeMenu.user)">Editar Vendas</a>
          <a @click="editUserStorage(activeMenu.user)">Editar Armazenamento</a>
          <a @click="editUserBilling(activeMenu.user)">Gerenciar Cobrança</a>
          <div class="dropdown-divider"></div>
          <a v-if="activeMenu.user.active" @click="handleToggleActive(activeMenu.user)" class="action-suspend">
            ⛔ Suspender Acesso
          </a>
          <a v-else @click="handleToggleActive(activeMenu.user)" class="action-activate">
            ✅ Ativar Acesso
          </a>
          <a @click="openDeleteUserModal(activeMenu.user)" class="action-delete">Excluir Usuário</a>
        </div>

        <!-- Modais (sem alterações) -->
        <UniversalModal title="Gerenciar Status de Venda (Global)" :is-open="isStatusManagerOpen" @close="closeStatusManagerModal">
          <div class="status-manager">
            <div class="status-creator">
              <input type="text" v-model="newStatusName" @keyup.enter="handleAddNewStatus" placeholder="Nome do novo status" class="status-input" />
              <button @click="handleAddNewStatus" class="btn btn-primary">Adicionar</button>
            </div>
            <p v-if="statusError" class="error-text">{{ statusError }}</p>
            <h4 class="modal-subtitle">Status Atuais</h4>
            <ul class="status-list">
              <li v-for="status in allUserStatuses" :key="status.value" class="status-item">
                <div v-if="editingStatus?.value !== status.value" class="status-display-mode">
                  <span>{{ status.label }}</span>
                  <div class="status-actions">
                    <button @click="startEditing(status)" class="btn-action edit" title="Editar"><svg fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>
                    <button @click="handleDeleteStatus(status)" class="btn-action delete" title="Excluir"><svg fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
                  </div>
                </div>
                <div v-else class="status-edit-mode">
                  <input type="text" v-model="editedStatusName" @keyup.enter="handleUpdateStatus(status)" @keyup.esc="cancelEditing" class="status-input-edit" />
                  <div class="status-actions">
                     <button @click="handleUpdateStatus(status)" class="btn-action save" title="Salvar"><svg fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg></button>
                     <button @click="cancelEditing" class="btn-action cancel" title="Cancelar"><svg fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
                  </div>
                </div>
              </li>
            </ul>
          </div>
        </UniversalModal>

        <UniversalModal title="Gerenciar Tipos de Pacote (Global)" :is-open="isPackageTypesModalOpen" @close="closePackageTypesModal">
            <div class="plan-manager-content">
                <form v-if="editingPackageType" @submit.prevent="handleSavePackageType" class="service-form" style="margin-bottom: 1.5rem;">
                  <h4 class="modal-subtitle" style="margin-top: 0;">{{ packageTypeForm.id ? 'Editar Pacote' : 'Novo Pacote' }}</h4>
                  <div class="form-group"><label>Nome do Pacote</label><input type="text" v-model="packageTypeForm.name" required /></div>
                  <div class="form-group"><label>Preço por Unidade (R$)</label><input type="number" v-model.number="packageTypeForm.price" min="0" step="0.01" required /></div>
                  <div class="modal-actions">
                    <button @click="cancelEditPackageType" type="button" class="btn btn-secondary">Cancelar</button>
                    <button type="submit" class="btn btn-primary">Salvar Pacote</button>
                  </div>
                </form>
                <button v-else @click="startNewPackageType" class="btn btn-primary btn-full-width">Adicionar Novo Tipo de Pacote</button>
                
                <h4 class="modal-subtitle">Tipos Existentes</h4>
                <div class="table-wrapper-modal">
                <table class="services-table-modal">
                    <thead><tr><th>Embalagem</th><th>Preço</th><th>Ações</th></tr></thead>
                    <tbody>
                    <tr v-if="isLoadingPackageTypes"><td colspan="3" class="feedback-cell">Carregando...</td></tr>
                    <tr v-else-if="allPackageTypes.length === 0"><td colspan="3" class="feedback-cell">Nenhum pacote cadastrado.</td></tr>
                    <tr v-for="pkg in allPackageTypes" :key="pkg.id">
                        <td><div class="service-name">{{ pkg.name }}</div></td>
                        <td>{{ formatCurrency(pkg.price) }}</td>
                        <td>
                        <button @click="editExistingPackageType(pkg)" class="btn-action edit" title="Editar"><svg fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>
                        <button @click="handleDeletePackageType(pkg.id)" class="btn-action delete" title="Excluir"><svg fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
                        </td>
                    </tr>
                    </tbody>
                </table>
                </div>
            </div>
        </UniversalModal>

        <UniversalModal title="Gerenciar Catálogo de Serviços" :is-open="isServiceCatalogueOpen" @close="closeServiceCatalogueModal">
            <div class="plan-manager-content">
                <button @click="openServiceModal()" class="btn btn-primary btn-full-width">Adicionar Novo Serviço</button>
                <h4 class="modal-subtitle">Serviços Existentes</h4>
                <div class="table-wrapper-modal">
                <table class="services-table-modal">
                    <thead><tr><th>Serviço</th><th>Preço</th><th>Ações</th></tr></thead>
                    <tbody>
                    <tr v-if="isLoadingServices"><td colspan="3" class="feedback-cell">Carregando...</td></tr>
                    <tr v-else-if="availableServices.length === 0"><td colspan="3" class="feedback-cell">Nenhum serviço cadastrado.</td></tr>
                    <tr v-for="service in availableServices" :key="service.id">
                        <td>
                        <div class="service-name">{{ service.name }}</div>
                        <div class="service-description">{{ service.description }}</div>
                        </td>
                        <td>{{ formatCurrency(service.price) }}</td>
                        <td>
                        <button @click="openServiceModal(service)" class="btn-action edit" title="Editar"><svg fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>
                        <button @click="openDeleteServiceModal(service)" class="btn-action delete" title="Excluir"><svg fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
                        </td>
                    </tr>
                    </tbody>
                </table>
                </div>
            </div>
        </UniversalModal>
        <UniversalModal :title="isEditingService ? 'Editar Serviço' : 'Adicionar Novo Serviço'" :is-open="isServiceModalOpen" @close="closeServiceModal">
          <form v-if="currentService" @submit.prevent="handleSaveService" class="service-form">
            <div class="form-group"><label>Nome do Serviço</label><input type="text" v-model="currentService.name" required /></div>
            <div class="form-group"><label>Preço (R$)</label><input type="number" v-model.number="currentService.price" min="0" step="0.01" required /></div>
          </form>
          <div class="modal-actions"><button @click="closeServiceModal" type="button" class="btn btn-secondary">Cancelar</button><button @click="handleSaveService" type="button" class="btn btn-primary">Salvar</button></div>
        </UniversalModal>
        <UniversalModal title="Confirmar Exclusão" :is-open="isDeleteServiceModalOpen" @close="closeDeleteServiceModal">
          <div v-if="serviceToDelete"><p>Tem certeza que deseja excluir o serviço <strong>"{{ serviceToDelete.name }}"</strong>?</p></div>
          <div class="modal-actions"><button @click="closeDeleteServiceModal" class="btn btn-secondary">Cancelar</button><button @click="handleConfirmDeleteService" class="btn btn-danger">Excluir</button></div>
        </UniversalModal>
        <UniversalModal title="Confirmar Exclusão de Usuário" :is-open="isDeleteUserModalOpen" @close="closeDeleteUserModal">
            <div v-if="userToDelete">
                <p>Tem certeza que deseja excluir o usuário <strong>{{ userToDelete.mlNickname || userToDelete.email }}</strong>?</p>
                <p class="warning-text"><strong>Atenção:</strong> Esta ação é irreversível e irá apagar permanentemente todos os dados associados a este usuário, incluindo vendas, contas, SKUs e históricos.</p>
            </div>
            <div class="modal-actions"><button @click="closeDeleteUserModal" class="btn btn-secondary">Cancelar</button><button @click="confirmDeleteUser" class="btn btn-danger">Sim, Excluir</button></div>
        </UniversalModal>
        <UniversalModal title="Editar Nome do Usuário" :is-open="isEditNameModalOpen" @close="closeEditNameModal">
          <div v-if="editNameUser">
            <p style="margin-bottom: 0.75rem; color: #6b7280;">Usuário: <strong>{{ editNameUser.mlNickname || editNameUser.email }}</strong></p>
            <div class="form-group">
              <label>Novo Nome</label>
              <input type="text" v-model="editNameValue" @keyup.enter="handleSaveName" placeholder="Digite o nome do usuário" />
            </div>
          </div>
          <div class="modal-actions">
            <button @click="closeEditNameModal" class="btn btn-secondary">Cancelar</button>
            <button @click="handleSaveName" class="btn btn-primary" :disabled="isSavingName">{{ isSavingName ? 'Salvando...' : 'Salvar' }}</button>
          </div>
        </UniversalModal>
        <UniversalModal :title="`Gerenciar Serviços de ${currentUser?.mlNickname || currentUser?.email}`" :is-open="isContractModalOpen" @close="closeContractModal">
          <div class="contract-modal-content">
            <h4 class="modal-subtitle">Serviços Atuais</h4>
            <div class="table-wrapper-modal">
              <table class="services-table-modal">
                <thead><tr><th>Serviço</th><th>Contratado em</th><th>Volume/Qtd</th><th>Ações</th></tr></thead>
                <tbody>
                  <tr v-if="isLoadingClientServices"><td colspan="4" class="feedback-cell">Carregando...</td></tr>
                  <tr v-else-if="clientServices.length === 0"><td colspan="4" class="feedback-cell">Nenhum serviço contratado.</td></tr>
                  <tr v-for="service in clientServices" :key="service.id">
                    <td>{{ service.name }}</td><td>{{ formatDate(service.startDate, true) }}</td><td>{{ service.volume || 'N/A' }}</td>
                    <td><button @click="handleRemoveClientService(service.id)" class="btn-action delete" title="Remover"><svg fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <h4 class="modal-subtitle">Adicionar Novo Serviço</h4>
            <form @submit.prevent="handleAddClientService" class="add-service-form">
              <div class="form-group"><label>Serviço</label><select v-model="newContract.serviceId" required><option disabled value="">Selecione</option><option v-for="s in availableServices" :key="s.id" :value="s.id">{{ s.name }}</option></select></div>
              <div class="form-group"><label>Volume (m³)/Qtd</label><input type="number" v-model.number="newContract.volume" required /></div>
              <div class="form-group"><label>Data de Início</label><input type="date" v-model="newContract.startDate" required /></div>
              <button type="submit" class="btn btn-primary add-btn">Adicionar</button>
            </form>
          </div>
        </UniversalModal>
        <UniversalModal :title="syncResults.title || 'Resultados da Sincronização'" :is-open="isSyncResultsModalOpen" @close="closeSyncResultsModal">
          <div class="sync-results-content">
            <div v-if="syncResults.message" class="sync-message" :class="syncResults.type"><p>{{ syncResults.message }}</p></div>
            <div v-if="syncResults.summary" class="sync-summary">
              <h4 class="modal-subtitle">📊 Resumo Geral</h4>
              <div class="summary-stats">
                <div class="stat-item"><span class="stat-label">• Total de usuários processados:</span><span class="stat-value">{{ syncResults.summary.totalUsers }}</span></div>
                <div class="stat-item"><span class="stat-label">• Usuários sem contas ML:</span><span class="stat-value">{{ syncResults.summary.usersWithoutAccounts }}</span></div>
                <div class="stat-item"><span class="stat-label">• Total de contas encontradas:</span><span class="stat-value">{{ syncResults.summary.totalAccountsFound }}</span></div>
                <div class="stat-item success"><span class="stat-label">• Sincronizadas com sucesso:</span><span class="stat-value">{{ syncResults.summary.successCount }}</span></div>
                <div class="stat-item error" v-if="syncResults.summary.errorCount > 0"><span class="stat-label">• Falharam:</span><span class="stat-value">{{ syncResults.summary.errorCount }}</span></div>
              </div>
              <div v-if="syncResults.details && syncResults.details.length > 0" class="user-details">
                <h4 class="modal-subtitle">👥 Detalhes por Usuário</h4>
                <div class="details-list">
                  <div v-for="detail in syncResults.details" :key="detail" class="detail-item">{{ detail }}</div>
                  <div v-if="syncResults.hasMoreUsers" class="detail-item more-users">... e mais {{ syncResults.remainingCount }} usuários</div>
                </div>
              </div>
            </div>
          </div>
          <div class="modal-actions"><button @click="closeSyncResultsModal" class="btn btn-primary">Fechar</button></div>
        </UniversalModal>
      </div>
    </div>
  </div>
  <ToastNotification 
    :is-visible="syncState.isVisible" 
    :title="syncState.title"
    :description="syncState.description" 
    :progress="syncState.progress" 
    :type="syncState.type" 
  />
</template>

<script setup>
import { ref, onMounted, computed, watch, nextTick } from 'vue';
import { gsap } from 'gsap';

import SidebarComponent from '../components/SidebarComponent.vue';
import TopbarComponent from '../components/TopbarComponent.vue';
import UniversalModal from '../components/UniversalModal.vue';
import UserSalesTable from '../components/UserSalesTable.vue';
// Importando o novo componente de tabela de vendas do Master
import MasterSalesTable from '../components/MasterSalesTable.vue';
import UserStorageView from './UserStorageView.vue';
import MasterResumoCobranca from './MasterResumoCobranca.vue';
import ServiceHistory from './ServiceHistory.vue';
import ToastNotification from '../components/ToastNotification.vue';
import { useUsers } from '@/composables/useUsers';
import { useGlobalStatuses } from '@/composables/useGlobalStatuses';
import { usePackageTypes } from '@/composables/usePackageTypes';
import { useServices } from '@/composables/useServices.js';
import { useSyncManager } from '@/composables/useSyncManager';
import { API_BASE_URL } from '@/config';

const { users, isLoading: isLoadingUsers, error: usersError, fetchUsers, updateUserRole, toggleUserActiveStatus, deleteUser } = useUsers();
const { syncState } = useSyncManager();
const {
  services: availableServices, isLoadingServices, isEditingService, currentService, isServiceModalOpen,
  isDeleteServiceModalOpen, serviceToDelete, openServiceModal, closeServiceModal, handleSaveService,
  openDeleteServiceModal, closeDeleteServiceModal, handleConfirmDeleteService, fetchServices, formatCurrency,
  clientServices, isLoadingClientServices, addClientService, fetchClientServices, removeClientService
} = useServices();

const currentView = ref('users');
const selectedUser = ref(null);
const activeMenu = ref({ user: null, style: {} });
const userSearchQuery = ref('');
const userStatusFilter = ref('all');
const currentPage = ref(1);
const itemsPerPage = ref(10);
const tableContainer = ref(null);
const actionsDropdown = ref(null);

const isStatusManagerOpen = ref(false);
const newStatusName = ref('');
const statusError = ref('');
const { globalStatuses: allUserStatuses, addGlobalStatus: addStatus, deleteGlobalStatus: deleteStatus, updateGlobalStatus: updateStatus, fetchGlobalStatuses } = useGlobalStatuses();
const editingStatus = ref(null);
const editedStatusName = ref('');

// Gerenciamento de Modal de Pacotes
const isPackageTypesModalOpen = ref(false);
const editingPackageType = ref(false);
const packageTypeForm = ref({ id: null, name: '', price: 0 });
const { packageTypes: allPackageTypes, isLoading: isLoadingPackageTypes, fetchPackageTypes, addPackageType, updatePackageType, deletePackageType } = usePackageTypes();

const isServiceCatalogueOpen = ref(false);
const isContractModalOpen = ref(false);
const currentUser = ref(null);
const newContract = ref({ serviceId: '', volume: 1, startDate: new Date().toISOString().split('T')[0] });
const isDeleteUserModalOpen = ref(false);
const userToDelete = ref(null);
const isSyncResultsModalOpen = ref(false);
const isEditNameModalOpen = ref(false);
const editNameUser = ref(null);
const editNameValue = ref('');
const isSavingName = ref(false);
const syncResults = ref({});

const filteredUsers = computed(() => {
  let list = users.value;

  // Filtro por status ativo/inativo
  if (userStatusFilter.value === 'active') {
    list = list.filter(u => u.active !== false);
  } else if (userStatusFilter.value === 'inactive') {
    list = list.filter(u => u.active === false);
  }

  // Filtro por texto
  if (userSearchQuery.value.trim()) {
    const query = userSearchQuery.value.toLowerCase();
    list = list.filter(u => 
      u.email.toLowerCase().includes(query) ||
      (u.mlNickname && u.mlNickname.toLowerCase().includes(query)) ||
      (u.name && u.name.toLowerCase().includes(query))
    );
  }

  return list;
});
const totalPages = computed(() => Math.ceil(filteredUsers.value.length / itemsPerPage.value));
const paginatedUsers = computed(() =>
  filteredUsers.value.slice((currentPage.value - 1) * itemsPerPage.value, currentPage.value * itemsPerPage.value)
);

// Atualizando o breadcrumb para incluir a nova visão
const breadcrumbTitle = computed(() => {
  const displayName = selectedUser.value ? (selectedUser.value.mlNickname || selectedUser.value.email) : '';
  if (currentView.value === 'sales') return `Vendas de ${displayName}`;
  if (currentView.value === 'storage') return `Armazenamento de ${displayName}`;
  if (currentView.value === 'billing') return `Resumo de Faturamento de ${displayName}`;
  if (currentView.value === 'history') return 'Histórico de Serviços';
  if (currentView.value === 'master_sales') return 'Visão Geral de Vendas';
  return '';
});

const formatDate = (timestamp, isDateString = false) => {
  if (!timestamp) return 'N/A';
  const date = isDateString ? new Date(timestamp.replace(/-/g, '/')) : new Date(timestamp);
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

const setView = (view) => {
  activeMenu.value.user = null;
  currentView.value = view;
  if (view === 'users') selectedUser.value = null;
  nextTick(() => animateRows());
};

const switchUserView = (view) => {
  if (!selectedUser.value) return;
  activeMenu.value.user = null;
  currentView.value = view;
};

const handleRoleChange = async (user, newRole) => {
    const originalRole = user.role;
    // Removendo o window.confirm para um ambiente sem browser-blocking popups
    const confirmed = true; // Simular confirmação
    if (confirmed) {
        const result = await updateUserRole(user.uid, newRole);
        if (!result.success) {
            // Idealmente, usar um toast de notificação aqui
            console.error(`Falha ao atualizar permissão: ${result.message}`);
        }
    } else {
        const selectElement = event.target;
        selectElement.value = originalRole;
    }
};

const toggleActionsMenu = async (user, event) => {
  const isSame = activeMenu.value.user && activeMenu.value.user.uid === user.uid;
  activeMenu.value = isSame ? { user: null } : {
    user,
    style: {
      top: `${event.target.getBoundingClientRect().bottom + 6}px`,
      left: `${event.target.getBoundingClientRect().left}px`
    }
  };
  await nextTick();
  if (activeMenu.value.user && actionsDropdown.value) {
    gsap.fromTo(actionsDropdown.value, { opacity: 0, y: -6, scale: 0.98 }, { opacity: 1, y: 0, scale: 1, duration: 0.18, ease: 'power1.out' });
  }
};

const editUserSales = (user) => { selectedUser.value = user; setView('sales'); };
const editUserStorage = (user) => { selectedUser.value = user; setView('storage'); };
const editUserBilling = (user) => { selectedUser.value = user; setView('billing'); };
const openDeleteUserModal = (user) => { userToDelete.value = user; isDeleteUserModalOpen.value = true; activeMenu.value.user = null; };
const closeDeleteUserModal = () => { isDeleteUserModalOpen.value = false; userToDelete.value = null; };

const handleToggleActive = async (user) => {
  activeMenu.value.user = null;
  const result = await toggleUserActiveStatus(user.uid, user.active);
  if (!result.success) {
    alert(result.message || 'Erro ao alterar status do usuário.');
  }
};
const closeSyncResultsModal = () => { isSyncResultsModalOpen.value = false; syncResults.value = {}; };

const openEditNameModal = (user) => {
  editNameUser.value = user;
  editNameValue.value = user.name || '';
  isEditNameModalOpen.value = true;
  activeMenu.value.user = null;
};
const closeEditNameModal = () => {
  isEditNameModalOpen.value = false;
  editNameUser.value = null;
  editNameValue.value = '';
};
const handleSaveName = async () => {
  if (!editNameUser.value || !editNameValue.value.trim()) return;
  isSavingName.value = true;
  try {
    const token = localStorage.getItem('authToken');
    const response = await fetch(`${API_BASE_URL}/users/${editNameUser.value.uid}/name`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ name: editNameValue.value.trim() }),
    });
    if (!response.ok) throw new Error('Falha ao atualizar nome');
    // Atualiza o nome localmente na lista
    const userInList = users.value.find(u => u.uid === editNameUser.value.uid);
    if (userInList) userInList.name = editNameValue.value.trim();
    closeEditNameModal();
  } catch (error) {
    console.error('Erro ao salvar nome:', error);
    alert('Erro ao salvar o nome. Tente novamente.');
  } finally {
    isSavingName.value = false;
  }
};

const confirmDeleteUser = async () => {
    if (!userToDelete.value) return;
    await deleteUser(userToDelete.value.uid);
    closeDeleteUserModal();
};

const openStatusManagerModal = async () => { 
  await fetchGlobalStatuses(); 
  isStatusManagerOpen.value = true; 
  await nextTick(); 
  animateModal(); 
};
const closeStatusManagerModal = () => { isStatusManagerOpen.value = false; newStatusName.value = ''; statusError.value = ''; cancelEditing(); };

const openPackageTypesModal = async () => {
  await fetchPackageTypes();
  isPackageTypesModalOpen.value = true;
  await nextTick();
  animateModal();
};
const closePackageTypesModal = () => { 
  isPackageTypesModalOpen.value = false; 
  cancelEditPackageType();
};
const startNewPackageType = () => {
  packageTypeForm.value = { id: null, name: '', price: 0 };
  editingPackageType.value = true;
};
const editExistingPackageType = (pkg) => {
  packageTypeForm.value = { id: pkg.id, name: pkg.name, price: pkg.price };
  editingPackageType.value = true;
};
const cancelEditPackageType = () => {
  editingPackageType.value = false;
  packageTypeForm.value = { id: null, name: '', price: 0 };
};
const handleSavePackageType = async () => {
  try {
    if (packageTypeForm.value.id) {
      await updatePackageType(packageTypeForm.value.id, { name: packageTypeForm.value.name, price: packageTypeForm.value.price });
    } else {
      await addPackageType({ name: packageTypeForm.value.name, price: packageTypeForm.value.price });
    }
    cancelEditPackageType();
  } catch (err) {
    alert("Erro ao salvar tipo de pacote: " + err.message);
  }
};
const handleDeletePackageType = async (id) => {
  if (confirm("Deseja mesmo excluir este tipo de pacote?")) {
    try {
      await deletePackageType(id);
    } catch (err) {
      alert("Erro ao excluir: " + err.message);
    }
  }
};

const handleAddNewStatus = async () => {
  statusError.value = '';
  try { await addStatus(newStatusName.value); newStatusName.value = ''; } 
  catch (e) { statusError.value = e.message; }
};

const handleDeleteStatus = (status) => {
    // Idealmente, usar um modal de confirmação aqui em vez de window.confirm
    deleteStatus(status);
};

const startEditing = (status) => { editingStatus.value = status; editedStatusName.value = status.label; };
const cancelEditing = () => { editingStatus.value = null; editedStatusName.value = ''; statusError.value = ''; };

const handleUpdateStatus = async (status) => {
  statusError.value = '';
  try { await updateStatus(status.value, editedStatusName.value); cancelEditing(); } 
  catch (e) { statusError.value = e.message; }
};

const openServiceCatalogueModal = async () => { fetchServices(); isServiceCatalogueOpen.value = true; await nextTick(); animateModal(); };
const closeServiceCatalogueModal = () => { isServiceCatalogueOpen.value = false; closeServiceModal(); };
const openContractModal = async (user) => { currentUser.value = user; fetchClientServices(user.uid); fetchServices(); isContractModalOpen.value = true; await nextTick(); animateModal(); };
const closeContractModal = () => { isContractModalOpen.value = false; currentUser.value = null; clientServices.value = []; };

const handleAddClientService = async () => {
  if (!currentUser.value) return;
  const service = availableServices.value.find(s => s.id === newContract.value.serviceId);
  if (!service) return;
  const contractData = { serviceId: newContract.value.serviceId, name: service.name, price: service.price, volume: newContract.value.volume, startDate: newContract.value.startDate };
  await addClientService(currentUser.value.uid, contractData);
  newContract.value = { serviceId: '', volume: 1, startDate: new Date().toISOString().split('T')[0] };
};
const handleRemoveClientService = async (contractId) => {
  if (!currentUser.value) return;
  // Usar um modal de confirmação
  await removeClientService(currentUser.value.uid, contractId);
};

const handleSyncAllAccounts = async () => {
  if (syncState.value.isSyncing) return;
  try {
    await fetchUsers();
    if (!users.value || users.value.length === 0) {
      syncResults.value = { title: 'Atenção', message: 'Nenhum usuário encontrado.', type: 'warning' };
      isSyncResultsModalOpen.value = true;
      return;
    }
    // Lógica de sincronização... (sem alterações)
    // ...
  } catch (err) {
    syncResults.value = { title: '❌ Erro Geral', message: err.message, type: 'error' };
    isSyncResultsModalOpen.value = true;
  }
};

const nextPage = () => { if (currentPage.value < totalPages.value) currentPage.value++; };
const prevPage = () => { if (currentPage.value > 1) currentPage.value--; };

const animateRows = () => {
  const rows = tableContainer.value?.querySelectorAll('tbody .row-anim');
  if (rows?.length) {
    gsap.fromTo(rows, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.28, ease: 'power1.out', stagger: 0.03 });
  }
};
const animateModal = () => {
  gsap.fromTo('.table-wrapper-modal, .service-form, .contract-modal-content, .status-manager',
    { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.22, ease: 'power1.out' });
};

onMounted(async () => { await fetchUsers(); nextTick(() => animateRows()); });
watch([paginatedUsers, currentPage], () => nextTick(() => animateRows()));
watch([userSearchQuery, userStatusFilter], () => { currentPage.value = 1; });
watch(() => syncState.value.isSyncing, (isSyncing, wasSyncing) => {
  if (wasSyncing && !isSyncing && syncState.value.progress === 100 && syncState.value.type !== 'error') {
    fetchUsers();
  }
});
</script>

<style scoped>
.users-wrapper {
  display: flex;
  height: 100vh;
  font-family: 'Inter', system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  background-color: #f7f8fa;
}

.main-content { 
  flex: 1; 
  display: flex; 
  flex-direction: column; 
  /* Adicionado para conter o overflow dos filhos */
  min-width: 0; 
}

.content-area { 
  flex: 1; 
  padding: 1.5rem; 
  /* Adicionado para ser um container flex e conter o overflow */
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.header {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 1rem; flex-wrap: wrap; gap: .75rem;
}
.header-actions { display: flex; gap: .75rem; flex-wrap: wrap; }
.sync-btn { display: inline-flex; align-items: center; gap: 0.5rem; position: relative; }
.new-sales-badge {
  position: absolute; top: -8px; right: -8px; background: #ef4444; color: white;
  border-radius: 50%; min-width: 20px; height: 20px; display: flex;
  align-items: center; justify-content: center; font-size: 0.75rem; font-weight: 600;
  border: 2px solid white; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); animation: pulse 2s infinite;
}
@keyframes pulse { 0% { transform: scale(1); } 50% { transform: scale(1.1); } 100% { transform: scale(1); } }
.sync-spinner { animation: spin 1.5s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.title { font-size: 1.65rem; font-weight: 700; color: #111827; margin: 0; }
.subtitle { margin-top: .25rem; font-size: .9rem; color: #6b7280; }
.breadcrumbs { display: flex; align-items: center; font-size: .9rem; margin-bottom: 1.25rem; }
.breadcrumb-link { color: #6366f1; text-decoration: none; background: none; border: none; cursor: pointer; padding: 0; }
.breadcrumb-separator { margin: 0 .5rem; color: #6b7280; }
.breadcrumb-active { color: #374151; font-weight: 500; }

/* User Context Panel - Navegação por abas dentro do usuário */
.user-context-panel {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 0.75rem;
  margin-bottom: 1.25rem;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(16, 24, 40, 0.06);
}
.user-context-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid #f3f4f6;
}
.btn-back {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 0.5rem;
  border: 1px solid #e5e7eb;
  background: #f9fafb;
  cursor: pointer;
  color: #6b7280;
  transition: all 0.15s;
  flex-shrink: 0;
}
.btn-back:hover {
  background: #f3f4f6;
  color: #374151;
  border-color: #d1d5db;
}
.user-context-info {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.user-context-name {
  font-size: 1.05rem;
  font-weight: 600;
  color: #111827;
}
.user-context-email {
  font-size: 0.8rem;
  color: #9ca3af;
}
.user-tabs {
  display: flex;
  padding: 0 0.5rem;
  gap: 0.25rem;
  background: #fafbfc;
}
.user-tab {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.7rem 1rem;
  font-size: 0.85rem;
  font-weight: 500;
  color: #6b7280;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.user-tab:hover {
  color: #374151;
  background: #f3f4f6;
}
.user-tab.active {
  color: #6366f1;
  border-bottom-color: #6366f1;
  background: #eef2ff;
}
/* Painel Visual de Cadastros Globais */
.global-settings-panel {
  background: #ffffff; border: 1px solid #e5e7eb; border-radius: 0.75rem;
  padding: 1.25rem; margin-bottom: 1.5rem;
  box-shadow: 0 1px 3px rgba(16, 24, 40, 0.04);
}
.panel-title {
  font-size: 0.95rem; font-weight: 600; color: #4b5563;
  margin-top: 0; margin-bottom: 1rem; border-bottom: 1px solid #f3f4f6; padding-bottom: 0.6rem;
}
.panel-buttons {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1rem;
}
.btn-global {
  display: flex; align-items: center; gap: 1rem; padding: 1rem;
  background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 0.6rem;
  cursor: pointer; transition: all 0.2s; text-align: left;
}
.btn-global:hover {
  background: #f3f4f6; border-color: #d1d5db; transform: translateY(-1px);
  box-shadow: 0 4px 6px rgba(0,0,0,0.02);
}
.btn-icon {
  display: flex; align-items: center; justify-content: center;
  width: 44px; height: 44px; border-radius: 0.5rem; flex-shrink: 0; color: white;
}
.bg-indigo { background: #6366f1; }
.bg-emerald { background: #10b981; }
.bg-amber { background: #f59e0b; }
.btn-icon svg { width: 22px; height: 22px; }
.btn-info { display: flex; flex-direction: column; gap: 0.2rem; }
.btn-title { font-weight: 600; font-size: 0.95rem; color: #111827; }
.btn-desc { font-size: 0.8rem; color: #6b7280; line-height: 1.2; }

/* Existing Styles */
.table-container { background-color: #ffffff; border: 1px solid #eef0f3; border-radius: .625rem; box-shadow: 0 1px 2px rgba(16, 24, 40, 0.06); overflow: hidden; }
.table-wrapper { max-width: 100%; overflow-x: auto; }
.users-table { width: 100%; min-width: 800px; border-collapse: collapse; }
.users-table th, .users-table td { padding: .9rem 1rem; text-align: left; border-bottom: 1px solid #e5e7eb; }
.users-table th { background-color: #fbfbfd; font-weight: 600; font-size: .72rem; text-transform: uppercase; color: #374151; }
.users-table td { font-size: .92rem; color: #111827; }
.users-table tbody tr:hover { background-color: #fafbff; }
.table-controls { display: flex; justify-content: space-between; align-items: center; margin-bottom: .75rem; }
.search-wrapper { position: relative; flex-grow: 1; max-width: 420px; }
.search-icon { position: absolute; left: .75rem; top: 50%; transform: translateY(-50%); width: 1rem; height: 1rem; color: #9ca3af; }
.search-input { width: 100%; padding: .55rem 1rem .55rem 2.25rem; font-size: .9rem; border: 1px solid #e5e7eb; border-radius: .5rem; }
.feedback-state { text-align: center; padding: 2.5rem 1rem; color: #6b7280; }
.btn { font-size: 0.85rem; font-weight: 500; padding: 0.45rem 0.8rem; border-radius: 0.45rem; border: 1px solid transparent; cursor: pointer; transition: background-color 0.15s; }
.btn-primary { background-color: #6366f1; color: #ffffff; }
.btn-primary:hover { background-color: #4f46e5; }
.btn-secondary { background-color: #f3f4f6; color: #374151; border-color: #e5e7eb; }
.btn-secondary:hover { background-color: #e9ebef; }
.btn-danger { background-color: #ef4444; color: #ffffff; }
.btn-danger:hover { background-color: #dc2626; }
.btn-action { background: none; border: none; padding: 0; cursor: pointer; }
.btn-sm { padding: .32rem .6rem; font-size: .78rem; }
.actions-button { background-color: #f9fafb; color: #374151; border: 1px solid #e5e7eb; padding: 0.45rem 0.8rem; border-radius: 0.45rem; cursor: pointer; }
.actions-dropdown-floating { position: fixed; z-index: 1000; background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: .5rem; box-shadow: 0 8px 24px rgba(16,24,40,.1); min-width: 180px; }
.actions-dropdown-floating a { display: block; padding: .7rem .9rem; font-size: .9rem; color: #374151; text-decoration: none; cursor: pointer; }
.actions-dropdown-floating a:hover { background-color: #f6f7fb; }
.dropdown-divider { height: 1px; background-color: #e5e7eb; margin: 0.5rem 0; }
.action-delete { color: #ef4444 !important; }
.pagination-controls { display: flex; justify-content: center; align-items: center; gap: .75rem; margin-top: 1rem; padding: 1rem 0; }
.pagination-controls button { padding: .5rem .9rem; border: 1px solid #e5e7eb; border-radius: .5rem; background-color: #ffffff; cursor: pointer; }
.pagination-controls button:disabled { opacity: .5; cursor: not-allowed; }
.form-group input, .form-group select, .role-select, .status-input { width: 100%; padding: .5rem .75rem; border: 1px solid #e5e7eb; border-radius: .5rem; }
.modal-actions { display: flex; justify-content: flex-end; gap: .5rem; margin-top: 1rem; }
.warning-text { margin-top: 1rem; padding: 0.75rem; background-color: #fffbeb; border-left: 4px solid #f59e0b; color: #b45309; }
.is-skeleton td { border-bottom-color: #eef0f3; }
.sk { position: relative; overflow: hidden; display: inline-block; height: 12px; border-radius: 6px; background: #eef1f5; }
.sk::after { content: ""; position: absolute; inset: 0; transform: translateX(-100%); background: linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,.6) 50%, rgba(255,255,255,0) 100%); animation: sk-shimmer 1.2s infinite; }
.sk-text { height: 12px; }
.sk-pill { height: 28px; border-radius: 999px; }
.sk-btn { height: 28px; border-radius: .5rem; }
@keyframes sk-shimmer { 100% { transform: translateX(100%); } }
/* Outros estilos de modais e etc. (sem alterações) */
.plan-manager-content, .status-manager, .contract-modal-content { padding: .5rem 0; }
.table-wrapper-modal { max-height: 320px; overflow-y: auto; border: 1px solid #e5e7eb; border-radius: .5rem; }
.services-table-modal { width: 100%; min-width: 600px; border-collapse: collapse; }
.services-table-modal th, .services-table-modal td { padding: .75rem; text-align: left; border-bottom: 1px solid #e5e7eb; }
.services-table-modal th { background-color: #fbfbfd; font-weight: 600; font-size: .75rem; text-transform: uppercase; }
.feedback-cell { text-align: center; color: #6b7280; }
.form-group { margin-bottom: 1rem; }
.form-group label { display: block; font-size: .85rem; font-weight: 600; margin-bottom: .25rem; }
.add-service-form { border-top: 1px solid #e5e7eb; padding-top: 1rem; }
.status-creator { display: flex; gap: .5rem; margin-bottom: 1rem; }
.modal-subtitle { font-size: 1rem; font-weight: 600; margin-top: 1.25rem; margin-bottom: .75rem; border-bottom: 1px solid #e5e7eb; padding-bottom: .5rem; }
.status-list { list-style: none; padding: 0; max-height: 250px; overflow-y: auto; }
.status-item { display: flex; justify-content: space-between; align-items: center; padding: .6rem .25rem; border-bottom: 1px solid #f3f4f6; }
.status-display-mode, .status-edit-mode { display: flex; justify-content: space-between; align-items: center; width: 100%; gap: 0.5rem; }
.status-actions { display: flex; gap: 0.5rem; }
.status-input-edit { flex-grow: 1; padding: .4rem .6rem; border: 1px solid #cbd5e1; border-radius: .5rem; }
.error-text { color: #ef4444; font-size: .85rem; margin-bottom: .75rem; }
.sync-results-content { max-height: 500px; overflow-y: auto; }
.sync-message { padding: 1rem; border-radius: 0.5rem; margin-bottom: 1rem; font-size: 0.9rem; }
.sync-message.warning { background-color: #fffbeb; border-left: 4px solid #f59e0b; color: #b45309; }
.sync-message.error { background-color: #fef2f2; border-left: 4px solid #ef4444; color: #dc2626; }
.sync-message.success { background-color: #f0fdf4; border-left: 4px solid #22c55e; color: #16a34a; }
.sync-summary { margin-bottom: 1rem; }
.summary-stats { background-color: #f9fafb; border-radius: 0.5rem; padding: 1rem; margin-bottom: 1.5rem; }
.stat-item { display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0; border-bottom: 1px solid #e5e7eb; }
.stat-item:last-child { border-bottom: none; }
.stat-value { font-weight: 600; }
.user-details { margin-top: 1.5rem; }
.details-list { background-color: #f9fafb; border-radius: 0.5rem; padding: 1rem; max-height: 200px; overflow-y: auto; }
.detail-item { padding: 0.4rem 0; font-size: 0.85rem; border-bottom: 1px solid #e5e7eb; font-family: 'Monaco', monospace; }

/* Status Filter and Pills */
.status-filter-wrapper {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-left: 1rem;
}
.filter-label {
  font-size: 0.85rem;
  font-weight: 600;
  color: #4b5563;
  white-space: nowrap;
}
.status-filter-select {
  padding: 0.45rem 2rem 0.45rem 0.75rem;
  font-size: 0.85rem;
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
  background-color: #ffffff;
  color: #374151;
  cursor: pointer;
  outline: none;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%236B7280'%3%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3E%3C/path%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 0.5rem center;
  background-size: 1.25rem;
  min-width: 120px;
}
.status-pill {
  display: inline-flex;
  padding: 0.25rem 0.6rem;
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
}
.pill-active {
  background-color: #dcfce7;
  color: #15803d;
}
.pill-inactive {
  background-color: #f1f5f9;
  color: #475569;
}
.row-inactive {
  opacity: 0.75;
}
.action-suspend {
  color: #dc2626 !important;
}
.action-activate {
  color: #16a34a !important;
}

@media (max-width: 768px) {
  .status-filter-wrapper {
    margin-left: 0;
    margin-top: 0.5rem;
    width: 100%;
  }
  .status-filter-select {
    flex-grow: 1;
  }
}
</style>

