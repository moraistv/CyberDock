# Requirements Document - Correção do Filtro de Período na Cobrança

## Introdução

Este documento define os requisitos para corrigir o bug no sistema de gerenciamento de cobrança onde itens de períodos incorretos estão sendo incluídos na cobrança mensal. Atualmente, ao abrir a cobrança de um mês específico (ex: setembro), aparecem itens de outros meses (ex: agosto), quando deveria mostrar apenas os serviços consumidos no período exato do mês selecionado.

## Problema Identificado

- **Situação Atual**: Cobrança do mês 9 (setembro) contém itens de agosto
- **Comportamento Esperado**: Cobrança deve conter apenas itens do período de 1º a 31 do mês selecionado
- **Impacto**: Inconsistência nos valores cobrados e dificuldade para auditoria

## Requirements

### Requirement 1

**User Story:** Como um usuário do sistema, eu quero que a cobrança mensal mostre apenas os serviços consumidos no período exato do mês selecionado, para que eu possa ter uma visão precisa dos custos do período.

#### Acceptance Criteria

1. WHEN eu abrir a cobrança de um mês específico THEN o sistema SHALL mostrar apenas itens com data de consumo dentro do período de 1º ao último dia desse mês
2. WHEN eu visualizar a cobrança de setembro (mês 9) THEN o sistema SHALL incluir apenas serviços consumidos entre 01/09 e 30/09
3. WHEN eu visualizar a cobrança de agosto (mês 8) THEN o sistema SHALL incluir apenas serviços consumidos entre 01/08 e 31/08

### Requirement 2

**User Story:** Como um usuário do sistema, eu quero que todos os tipos de serviços (vendas expedidas, armazenamento, serviços avulsos) sejam filtrados corretamente por período, para que a cobrança seja consistente em todas as categorias.

#### Acceptance Criteria

1. WHEN o sistema gerar a cobrança THEN SHALL aplicar o filtro de período para vendas expedidas
2. WHEN o sistema gerar a cobrança THEN SHALL aplicar o filtro de período para serviços de armazenamento
3. WHEN o sistema gerar a cobrança THEN SHALL aplicar o filtro de período para serviços avulsos
4. WHEN o sistema gerar a cobrança THEN SHALL aplicar o filtro de período para todos os outros tipos de serviços

### Requirement 3

**User Story:** Como um usuário do sistema, eu quero que o filtro de data seja baseado na data de consumo/execução do serviço e não na data de criação/lançamento, para que a cobrança reflita quando o serviço foi realmente utilizado.

#### Acceptance Criteria

1. WHEN o sistema filtrar itens para cobrança THEN SHALL usar a data de consumo/execução do serviço como critério
2. WHEN um serviço foi lançado em agosto mas consumido em setembro THEN SHALL aparecer na cobrança de setembro
3. WHEN um serviço foi consumido em agosto mas lançado em setembro THEN SHALL aparecer na cobrança de agosto

### Requirement 4

**User Story:** Como um usuário do sistema, eu quero que o período de cobrança seja claramente definido como do dia 1º ao último dia do mês, para que não haja ambiguidade sobre quais itens devem ser incluídos.

#### Acceptance Criteria

1. WHEN o sistema calcular o período de cobrança THEN SHALL usar 00:00:00 do dia 1º como início
2. WHEN o sistema calcular o período de cobrança THEN SHALL usar 23:59:59 do último dia do mês como fim
3. WHEN o sistema processar itens de cobrança THEN SHALL incluir apenas itens com timestamp dentro do período definido

### Requirement 5

**User Story:** Como um usuário do sistema, eu quero que a correção seja aplicada retroativamente para cobranças já geradas, para que eu possa auditar e corrigir cobranças anteriores se necessário.

#### Acceptance Criteria

1. WHEN a correção for implementada THEN o sistema SHALL permitir recalcular cobranças de meses anteriores
2. WHEN eu solicitar recálculo de uma cobrança THEN o sistema SHALL aplicar o novo filtro de período correto
3. WHEN uma cobrança for recalculada THEN o sistema SHALL manter um log das alterações realizadas

### Requirement 6

**User Story:** Como um desenvolvedor, eu quero que o sistema tenha logs detalhados do processo de filtro de cobrança, para que eu possa debugar problemas futuros relacionados ao período de cobrança.

#### Acceptance Criteria

1. WHEN o sistema processar uma cobrança THEN SHALL registrar em log o período utilizado para filtro
2. WHEN o sistema filtrar itens THEN SHALL registrar quantos itens foram incluídos/excluídos por período
3. WHEN houver inconsistências de data THEN o sistema SHALL registrar warnings nos logs