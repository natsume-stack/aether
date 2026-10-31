[CmdletBinding()]
param(
  [switch]$StartOnly,
  [switch]$Reconfigure,
  [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$PackageRoot = $PSScriptRoot
$ComposeFile = Join-Path $PackageRoot 'docker-compose.yml'
$EnvExample = Join-Path $PackageRoot '.env.example'
$EnvFile = Join-Path $PackageRoot '.env'
$Archive = Get-ChildItem -LiteralPath $PackageRoot -Filter 'box-local-engine-images-*-windows-amd64.tar.gz' |
  Select-Object -First 1

function Write-Step([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Invoke-Docker([string[]]$Arguments, [switch]$AllowFailure) {
  & docker @Arguments
  $exitCode = $LASTEXITCODE
  if (-not $AllowFailure -and $exitCode -ne 0) {
    throw "Docker command failed (exit code $exitCode): docker $($Arguments -join ' ')"
  }
  return $exitCode
}

function New-RandomHex([int]$Bytes = 32) {
  $buffer = New-Object byte[] $Bytes
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($buffer)
  } finally {
    $generator.Dispose()
  }
  return -join ($buffer | ForEach-Object { $_.ToString('x2') })
}

function Get-EnvValue([string]$Content, [string]$Name) {
  $match = [regex]::Match($Content, "(?m)^$([regex]::Escape($Name))=(.*)$")
  if ($match.Success) { return $match.Groups[1].Value.Trim() }
  return ''
}

function Set-EnvValue([string]$Content, [string]$Name, [string]$Value) {
  if ($Value -match "[`r`n]") { throw "Environment value $Name contains a newline." }
  $pattern = "(?m)^$([regex]::Escape($Name))=.*$"
  $line = "$Name=$Value"
  if ([regex]::IsMatch($Content, $pattern)) {
    return ([regex]::new($pattern)).Replace($Content, { param($unused) $line }, 1)
  }
  return "$($Content.TrimEnd())`r`n$line`r`n"
}

function Save-Env([string]$Content) {
  $normalized = $Content -replace "(?<!`r)`n", "`r`n"
  [System.IO.File]::WriteAllText(
    $EnvFile,
    $normalized,
    [System.Text.UTF8Encoding]::new($false)
  )
}

function Test-Configured([string]$Content) {
  foreach ($name in @(
      'PERMISSION_TOKEN_SECRET',
      'BOX_PLAYER_AUTH_API_KEY',
      'BOX_PLAY_ADMIN_TOKEN',
      'BOX_DATABASE_URL'
    )) {
    $value = Get-EnvValue $Content $name
    if ([string]::IsNullOrWhiteSpace($value) -or $value.StartsWith('CHANGE_ME')) {
      return $false
    }
  }
  return $true
}

function Initialize-Configuration {
  if (-not (Test-Path -LiteralPath $EnvExample -PathType Leaf)) {
    throw 'Missing .env.example.'
  }

  $existing = Test-Path -LiteralPath $EnvFile -PathType Leaf
  if ($existing) {
    $content = [System.IO.File]::ReadAllText($EnvFile)
    if (-not $Reconfigure -and (Test-Configured $content)) {
      Write-Host 'Using the existing .env. Existing secrets and database settings were preserved.'
      return
    }
  } else {
    $content = [System.IO.File]::ReadAllText($EnvExample)
  }

  Write-Step '配置数据库'
  Write-Host '[1] 内置 PostgreSQL + Redis'
  Write-Host '[2] 使用已有的 PostgreSQL 服务器'
  $mode = Read-Host '请选择 [1]'
  if ([string]::IsNullOrWhiteSpace($mode)) { $mode = '1' }
  if ($mode -notin @('1', '2')) { throw '无效选项，请重新运行部署向导。' }

  $permissionSecret = Get-EnvValue $content 'PERMISSION_TOKEN_SECRET'
  if ([string]::IsNullOrWhiteSpace($permissionSecret) -or $permissionSecret.StartsWith('CHANGE_ME')) {
    $permissionSecret = New-RandomHex
  }
  $authKey = Get-EnvValue $content 'BOX_PLAYER_AUTH_API_KEY'
  if ([string]::IsNullOrWhiteSpace($authKey) -or $authKey.StartsWith('CHANGE_ME')) {
    $authKey = New-RandomHex
  }
  $adminToken = Get-EnvValue $content 'BOX_PLAY_ADMIN_TOKEN'
  if ([string]::IsNullOrWhiteSpace($adminToken) -or $adminToken.StartsWith('CHANGE_ME')) {
    $adminToken = New-RandomHex
  }

  $content = Set-EnvValue $content 'PERMISSION_TOKEN_SECRET' $permissionSecret
  $content = Set-EnvValue $content 'BOX_PLAYER_AUTH_API_KEY' $authKey
  $content = Set-EnvValue $content 'BOX_PLAY_ADMIN_TOKEN' $adminToken
  $content = Set-EnvValue $content 'BOX_PLAYER_LOGIN_URL' 'http://127.0.0.1:3125'
  $content = Set-EnvValue $content 'BOX_PLAYER_AUTH_ALLOWED_ORIGINS' 'http://127.0.0.1:3121,http://127.0.0.1:3127,http://127.0.0.1:3125'

  if ($mode -eq '1') {
    $databasePassword = Get-EnvValue $content 'BOX_POSTGRES_PASSWORD'
    if (
      [string]::IsNullOrWhiteSpace($databasePassword) -or
      $databasePassword.StartsWith('CHANGE_ME') -or
      $databasePassword -eq 'not-used-with-external-database'
    ) {
      $databasePassword = New-RandomHex 24
    }
    $redisPassword = Get-EnvValue $content 'BOX_REDIS_PASSWORD'
    if ([string]::IsNullOrWhiteSpace($redisPassword) -or $redisPassword.StartsWith('CHANGE_ME')) {
      $redisPassword = New-RandomHex 24
    }
    $content = Set-EnvValue $content 'COMPOSE_PROFILES' 'infra,player-service,auth-portal,creator,play,voxa'
    $content = Set-EnvValue $content 'BOX_POSTGRES_PASSWORD' $databasePassword
    $content = Set-EnvValue $content 'BOX_DATABASE_URL' "postgresql://box:$databasePassword@postgres:5432/box"
    $content = Set-EnvValue $content 'BOX_DATABASE_SSL' 'false'
    $content = Set-EnvValue $content 'BOX_REDIS_PASSWORD' $redisPassword
    $content = Set-EnvValue $content 'REDIS_HOST' 'redis'
    $content = Set-EnvValue $content 'REDIS_PASSWORD' $redisPassword
  } else {
    Write-Host "`n请输入 PostgreSQL 连接信息。数据表会由引擎自动创建，不需要填表名。"
    $databaseHost = (Read-Host '数据库地址/IP').Trim()
    $databaseHost = $databaseHost -replace '^https?://', ''
    $databaseHost = $databaseHost.TrimEnd('/')
    if ([string]::IsNullOrWhiteSpace($databaseHost) -or $databaseHost -match '[/@\s]') {
      throw '数据库地址无效，请只填 IP 或域名，不要带 http:// 或路径。'
    }
    $databasePort = Read-Host '数据库端口 [5432]'
    if ([string]::IsNullOrWhiteSpace($databasePort)) { $databasePort = '5432' }
    $parsedDatabasePort = 0
    if (
      -not [int]::TryParse($databasePort, [ref]$parsedDatabasePort) -or
      $parsedDatabasePort -lt 1 -or
      $parsedDatabasePort -gt 65535
    ) {
      throw '数据库端口必须是 1-65535 之间的整数。'
    }
    $databaseName = (Read-Host '数据库名 [box]').Trim()
    if ([string]::IsNullOrWhiteSpace($databaseName)) { $databaseName = 'box' }
    $databaseUser = (Read-Host '数据库账号 [box]').Trim()
    if ([string]::IsNullOrWhiteSpace($databaseUser)) { $databaseUser = 'box' }
    $secureDatabasePassword = Read-Host '数据库密码（输入时不显示）' -AsSecureString
    $databaseCredential = New-Object System.Management.Automation.PSCredential(
      $databaseUser,
      $secureDatabasePassword
    )
    $databasePassword = $databaseCredential.GetNetworkCredential().Password
    if ([string]::IsNullOrWhiteSpace($databasePassword)) { throw '数据库密码不能为空。' }

    $uriHost = $databaseHost
    if ($uriHost.Contains(':') -and -not $uriHost.StartsWith('[')) { $uriHost = "[$uriHost]" }
    $encodedDatabaseUser = [uri]::EscapeDataString($databaseUser)
    $encodedDatabasePassword = [uri]::EscapeDataString($databasePassword)
    $encodedDatabaseName = [uri]::EscapeDataString($databaseName)
    $databaseURL = "postgresql://${encodedDatabaseUser}:${encodedDatabasePassword}@${uriHost}:${parsedDatabasePort}/${encodedDatabaseName}"
    $useSSL = Read-Host '数据库是否要求 SSL？[y/N]'
    $content = Set-EnvValue $content 'COMPOSE_PROFILES' 'player-service,auth-portal,creator,play,voxa'
    $content = Set-EnvValue $content 'BOX_DATABASE_URL' $databaseURL
    $content = Set-EnvValue $content 'BOX_DATABASE_SSL' $(if ($useSSL -match '^(y|yes)$') { 'true' } else { 'false' })

    $redisHost = Read-Host '可选：Redis 主机（不使用请直接回车）'
    if ([string]::IsNullOrWhiteSpace($redisHost)) {
      $content = Set-EnvValue $content 'REDIS_HOST' ''
      $content = Set-EnvValue $content 'REDIS_PASSWORD' ''
    } else {
      $redisPort = Read-Host 'Redis 端口 [6379]'
      if ([string]::IsNullOrWhiteSpace($redisPort)) { $redisPort = '6379' }
      if ($redisPort -notmatch '^\d{1,5}$') { throw 'Redis 端口无效。' }
      $secureRedisPassword = Read-Host 'Redis 密码（输入时不显示，无密码请回车）' -AsSecureString
      $redisCredential = New-Object System.Management.Automation.PSCredential(
        'redis',
        $secureRedisPassword
      )
      $redisPassword = $redisCredential.GetNetworkCredential().Password
      $content = Set-EnvValue $content 'REDIS_HOST' $redisHost
      $content = Set-EnvValue $content 'REDIS_PORT' $redisPort
      $content = Set-EnvValue $content 'REDIS_PASSWORD' $redisPassword
    }
  }

  Save-Env $content
  Write-Host '已生成 .env，三个服务密钥由安全随机数自动生成。' -ForegroundColor Green
}

function Ensure-Images {
  $content = [System.IO.File]::ReadAllText($EnvFile)
  $tag = Get-EnvValue $content 'BOX_IMAGE_TAG'
  if ([string]::IsNullOrWhiteSpace($tag)) { throw '.env 缺少 BOX_IMAGE_TAG。' }

  $images = @(
    "box-local-engine-creator:$tag",
    "box-local-engine-play:$tag",
    "box-local-engine-player-service:$tag",
    "box-local-engine-voxa:$tag",
    "box-local-engine-player-auth-portal:$tag"
  )
  $expectedRevision = ''
  $expectedImageRevisions = @{}
  $expectedImageCreatedAt = @{}
  $buildInfoPath = Join-Path $PackageRoot 'BUILD-INFO.json'
  if (Test-Path -LiteralPath $buildInfoPath -PathType Leaf) {
    try {
      $buildInfo = [System.IO.File]::ReadAllText($buildInfoPath) | ConvertFrom-Json
      $expectedRevision = $buildInfo.sourceRevision
      $imageRevisionsProperty = $buildInfo.PSObject.Properties['imageRevisions']
      if ($null -ne $imageRevisionsProperty -and $null -ne $imageRevisionsProperty.Value) {
        foreach ($property in $imageRevisionsProperty.Value.PSObject.Properties) {
          $expectedImageRevisions[$property.Name] = [string]$property.Value
        }
      }
      $imageCreatedAtProperty = $buildInfo.PSObject.Properties['imageCreatedAt']
      if ($null -ne $imageCreatedAtProperty -and $null -ne $imageCreatedAtProperty.Value) {
        foreach ($property in $imageCreatedAtProperty.Value.PSObject.Properties) {
          $expectedImageCreatedAt[$property.Name] = [string]$property.Value
        }
      }
    } catch {
      throw 'BUILD-INFO.json 格式无效。'
    }
  }
  $needsImport = @()
  foreach ($image in $images) {
    $imageExpectedRevision = $expectedRevision
    if ($expectedImageRevisions.ContainsKey($image)) {
      $imageExpectedRevision = $expectedImageRevisions[$image]
    }
    $imageExpectedCreatedAt = ''
    if ($expectedImageCreatedAt.ContainsKey($image)) {
      $imageExpectedCreatedAt = $expectedImageCreatedAt[$image]
    }
    $metadata = (& docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}|{{ index .Config.Labels "org.opencontainers.image.created" }}' $image 2>$null)
    if ($LASTEXITCODE -ne 0) {
      $needsImport += $image
    } else {
      $metadataParts = $metadata -split '\|', 2
      $revision = $metadataParts[0]
      $createdAt = $(if ($metadataParts.Count -gt 1) { $metadataParts[1] } else { '' })
      if (
        (-not [string]::IsNullOrWhiteSpace($imageExpectedRevision) -and $revision -ne $imageExpectedRevision) -or
        (-not [string]::IsNullOrWhiteSpace($imageExpectedCreatedAt) -and $createdAt -ne $imageExpectedCreatedAt)
      ) {
        $needsImport += $image
      }
    }
  }
  if ($needsImport.Count -eq 0) {
    Write-Host '五个应用镜像的版本已与离线包一致，跳过导入。'
    return
  }
  if ($null -eq $Archive) { throw '离线镜像归档不存在。' }
  Write-Host "正在导入镜像：$($Archive.Name)，请耐心等待…"
  Invoke-Docker -Arguments @('load', '-i', $Archive.FullName) | Out-Null
  foreach ($image in $images) {
    $imageExpectedRevision = $expectedRevision
    if ($expectedImageRevisions.ContainsKey($image)) {
      $imageExpectedRevision = $expectedImageRevisions[$image]
    }
    $imageExpectedCreatedAt = ''
    if ($expectedImageCreatedAt.ContainsKey($image)) {
      $imageExpectedCreatedAt = $expectedImageCreatedAt[$image]
    }
    $details = (& docker image inspect --format '{{.Os}}/{{.Architecture}}|{{ index .Config.Labels "org.opencontainers.image.revision" }}|{{ index .Config.Labels "org.opencontainers.image.created" }}' $image 2>$null)
    if ($LASTEXITCODE -ne 0) { throw "镜像导入后仍不存在：$image" }
    $detailParts = $details -split '\|', 3
    if ($detailParts[0] -ne 'linux/amd64') { throw "镜像架构不是 linux/amd64：$image ($details)" }
    if (-not [string]::IsNullOrWhiteSpace($imageExpectedRevision) -and $detailParts[1] -ne $imageExpectedRevision) {
      throw "镜像版本与离线包不一致：$image"
    }
    if (-not [string]::IsNullOrWhiteSpace($imageExpectedCreatedAt) -and $detailParts[2] -ne $imageExpectedCreatedAt) {
      throw "镜像构建时间与离线包不一致：$image"
    }
  }
}

function Wait-Endpoint([string]$Name, [string]$URL, [int]$TimeoutSeconds = 180) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    try {
      $response = Invoke-WebRequest -Uri $URL -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
        Write-Host "  [OK] $Name" -ForegroundColor Green
        return $true
      }
    } catch {
      Start-Sleep -Seconds 3
    }
  } while ((Get-Date) -lt $deadline)
  Write-Host "  [FAIL] $Name ($URL)" -ForegroundColor Red
  return $false
}

try {
  Set-Location $PackageRoot
  if (-not (Test-Path -LiteralPath $ComposeFile -PathType Leaf)) { throw 'Missing docker-compose.yml.' }

  Write-Step '检查 Docker Desktop'
  if ($null -eq (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw '未安装 Docker Desktop。请安装并启动 Docker Desktop 后重试。'
  }
  & docker info *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop 未启动，或尚未切换到 Linux containers。' }
  & docker compose version *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Docker Compose 不可用，请更新 Docker Desktop。' }
  $dockerPlatform = (& docker info --format '{{.OSType}}/{{.Architecture}}').Trim()
  if ($dockerPlatform -notmatch '^linux/(amd64|x86_64)$') {
    Write-Host "[WARN] 当前 Docker 平台为 $dockerPlatform，本包是 linux/amd64，可能无法运行或速度较慢。" -ForegroundColor Yellow
  }

  if (-not $StartOnly -and (Test-Path -LiteralPath (Join-Path $PackageRoot 'verify-package.ps1'))) {
    Write-Step '校验离线包完整性'
    & (Join-Path $PackageRoot 'verify-package.ps1')
  }

  Write-Step '准备配置'
  if ($StartOnly) {
    if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
      throw '尚未配置。请先双击 ONE-CLICK-DEPLOY.cmd。'
    }
    $current = [System.IO.File]::ReadAllText($EnvFile)
    if (-not (Test-Configured $current)) {
      throw '.env 配置不完整。请重新运行 ONE-CLICK-DEPLOY.cmd。'
    }
  } else {
    Initialize-Configuration
  }

  Write-Step '准备应用镜像'
  Ensure-Images

  Write-Step '启动 BOX Local Engine'
  Invoke-Docker -Arguments @(
    'compose', '--env-file', $EnvFile, '-f', $ComposeFile, 'up', '-d'
  ) | Out-Null

  Write-Step '检查服务状态'
  $checks = @(
    (Wait-Endpoint 'Player Service' 'http://127.0.0.1:3124/api/health-check')
    (Wait-Endpoint 'Login Portal' 'http://127.0.0.1:3125/api/health-check')
    (Wait-Endpoint 'Creator' 'http://127.0.0.1:3127/api/health-check')
    (Wait-Endpoint 'Play' 'http://127.0.0.1:3121/api/health-check')
    (Wait-Endpoint 'VOXA' 'http://127.0.0.1:3123/')
  )
  if ($checks -contains $false) {
    Write-Host "`n部分服务未就绪，当前容器状态：" -ForegroundColor Yellow
    & docker compose --env-file $EnvFile -f $ComposeFile ps
    Write-Host '可运行 logs.cmd 查看详细日志。' -ForegroundColor Yellow
    exit 1
  }

  Write-Host "`n部署完成：" -ForegroundColor Green
  Write-Host '  Creator       http://127.0.0.1:3127/'
  Write-Host '  Play          http://127.0.0.1:3121/'
  Write-Host '  Player Admin  http://127.0.0.1:3124/players'
  Write-Host '  Login Portal  http://127.0.0.1:3125/'
  if (-not $NoOpen) { Start-Process 'http://127.0.0.1:3127/' }
  exit 0
} catch {
  Write-Host "`n[ERROR] $($_.Exception.Message)" -ForegroundColor Red
  Write-Host '修复后可直接重新双击 ONE-CLICK-DEPLOY.cmd，不会删除已有数据。' -ForegroundColor Yellow
  exit 1
}
