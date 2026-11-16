# Convites, criação de senha e recuperação de acesso

A implementação acrescenta somente o fluxo de acesso. A URL publicada, `supabase-config.js`, SDK, consultas, salvamento de projetos, versões, sincronização, conflitos, tabelas e políticas RLS continuam iguais. O cadastro de contas e a autorização dos participantes continuam administrativos. Não há cadastro público no dashboard.

## Configuração manual no Supabase

Estas configurações **não são alteradas pelo código ou pelo Pull Request**. No projeto correto, abra **Authentication → URL Configuration** e defina:

**Site URL**

```text
https://viniciustestes.github.io/dashboard-projetos-poc/
```

**Redirect URLs** — adicione estes endereços exatos:

```text
https://viniciustestes.github.io/dashboard-projetos-poc/
https://viniciustestes.github.io/dashboard-projetos-poc/?auth=recovery
https://viniciustestes.github.io/dashboard-projetos-poc/?auth=invite
```

A raiz atende ao convite padrão enviado pelo painel. A recuperação usa explicitamente `?auth=recovery`. A variante `?auth=invite` permite convites cujo administrador configure esse destino. Não é necessário usar curingas nem alterar o endereço do GitHub Pages. Remova destinos temporários apenas se não forem mais usados por outros fluxos do projeto.

Em Authentication, mantenha o provedor Email habilitado e o cadastro público desabilitado. As contas devem ser criadas pelo administrador via **Invite user**, sem senha compartilhada. Confirme a disponibilidade do envio de e-mails/SMTP, os limites e a validade dos links. A configuração de SMTP ou templates não foi alterada nesta tarefa.

Os templates padrão de convite e recuperação devem manter o link **`{{ .ConfirmationURL }}`**. Esse link passa pela verificação do Supabase antes de redirecionar ao dashboard, levando uma sessão temporária no fragmento da URL. Não substitua pelo endereço da aplicação sem os dados de verificação. Templates personalizados com `token_hash` e `type=invite` ou `type=recovery` também são processados pela API oficial `verifyOtp`; não é necessário personalizar templates para usar esta entrega.

## Validar o convite com o segundo e-mail (Marcos)

1. Após revisar e integrar o PR, aguarde o GitHub Pages publicar a versão aprovada. Esta implementação não faz merge nem deployment.
2. No Supabase, confirme as URLs acima e use Authentication / Users / Invite user para enviar o convite ao segundo e-mail. Não crie uma senha para a pessoa.
3. Pelo procedimento administrativo já existente, autorize o UUID dessa conta em `dashboard_private.participantes`, com `ativo=true`. O convite cria a conta Auth, mas **não concede participação automaticamente**. Não é necessário recriar tabelas ou executar scripts SQL para esta implementação.
4. Abra o e-mail no navegador de teste e clique no link completo. Deve aparecer **Criar minha senha**, com os campos de senha e confirmação. O dashboard não carrega os projetos enquanto a pessoa define a senha.
5. Informe uma senha com 8 a 72 caracteres e confirme. O Supabase pode aplicar uma política adicional de força de senha. Ao salvar, a sessão temporária local é encerrada e o formulário de login reaparece com o e-mail preenchido.
6. Entre com o e-mail e a senha criada. Uma conta autorizada deve visualizar os seis projetos, editar e salvar normalmente. Confira a persistência ao recarregar e a atualização em outro navegador, usando somente dados fictícios.
7. Uma conta sem participação ativa deve continuar sem acesso aos projetos, mesmo que tenha aceitado o convite e definido senha.

## Validar recuperação

1. Na tela de login, clique **Esqueci minha senha** e informe o e-mail da conta.
2. O dashboard chama `resetPasswordForEmail` com o destino de produção `?auth=recovery`. A mensagem não informa se a conta existe.
3. No e-mail recebido, abra o link completo. Deve aparecer **Definir nova senha**.
4. Confirme e salve a nova senha. Depois entre pelo login normal, confira os projetos e teste que a senha anterior não autentica mais.
5. Teste confirmações diferentes, senha recusada pelo Supabase e um link expirado/já utilizado. Não deve haver mensagem de sucesso sem retorno positivo da API. Um link inválido deve orientar a solicitar novo convite/recuperação, sem mostrar tokens.

Não encaminhe links de convite ou recuperação a terceiros. Um link que foi consumido por um scanner de e-mail ou já foi usado pode exigir reenvio pelo administrador. O botão Voltar ao login descarta os campos de senha e encerra apenas a sessão temporária local.

## Integração e limites técnicos

- `dashboard-auth-access.js` contém as novas telas e operações de acesso. Não faz consultas de projetos, não chama `signUp` e não usa chaves administrativas.
- Fragmentos `access_token` + `refresh_token` com `type=invite|recovery` usam `auth.setSession`.
- Links com `token_hash` e o mesmo tipo usam `auth.verifyOtp`.
- Callbacks `code` só são aceitos com o propósito explícito de convite/recuperação; `auth.exchangeCodeForSession` trata o código. O aplicativo preserva o armazenamento em memória e o fluxo implícito já existentes. Um fluxo PKCE que dependa de um verificador perdido após navegação será recusado com mensagem: esta alteração não muda o armazenamento para contornar essa condição. Os links padrão de convite/recuperação acima usam o fluxo implícito.
- Senhas são definidas por `auth.updateUser({password})`. Nenhuma senha é salva no código, localStorage ou JSONB dos projetos.
- Os tokens de retorno são removidos da barra de endereço antes de iniciar chamadas assíncronas; não são registrados ou exibidos.
- O login existente fica impedido de concorrer com o processamento do link e com a tela de senha. Não há leitura de projetos nesse estágio.
- A origem carrega uma cópia inline de `dashboard-supabase.js` em `index.html`. Ela foi mantida idêntica à fonte, com somente os pontos de ligação do módulo de acesso adicionados. Não houve substituição ou reorganização desse caminho de execução.

## Testes e homologação

Consulte `testes/README.md`. Os testes automatizados usam SDK real com HTTP simulado e regressão de seis navegadores com backend simulado; não enviam e-mails nem acessam o Supabase real.

Nenhuma conta, senha, projeto, política RLS ou configuração administrativa foi alterada no Supabase. O envio real do convite, entrega do e-mail, URLs administrativas, conta autorizada, persistência PostgreSQL real e Realtime real precisam da validação manual acima. O ambiente não recebeu credenciais de um participante para testar login real.
