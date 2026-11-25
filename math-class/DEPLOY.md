# 클라우드 배포 안내

수학 풀이 교실을 학교 밖에서도 접속할 수 있도록 클라우드에 올리는 방법입니다.
**Fly.io** 와 **Railway** 두 가지 설정이 들어 있으니 하나만 고르면 됩니다. 두 곳 모두 HTTPS 주소를 자동으로 주고, 영구 디스크(볼륨)를 붙일 수 있습니다.

> 이 문서는 절차 안내일 뿐이며, 저장소에 이 파일들이 있다고 해서 자동으로 배포되지는 않습니다. 계정 생성과 결제 수단 등록은 직접 하셔야 합니다.

## ⚠️ 먼저 읽어 주세요: 학생 개인정보가 외부 서버에 저장됩니다

클라우드에 배포하면 아래 정보가 **학교 밖 회사(Fly.io 또는 Railway, 미국 기업)의 서버**에 저장됩니다. Fly.io 도쿄 리전을 고르면 일본에 있는 데이터센터에, Railway는 선택한 리전(미국·유럽·아시아)에 저장됩니다.

| 저장되는 정보 | 위치 |
|---|---|
| 학생 **이름**, **학번**, 학급(학년도·학년·반) | `/data/app.db` (SQLite) |
| 학생 비밀번호 (해시로 저장) | `/data/app.db` |
| **풀이 기록**: 펜 필기 획과 시간, 제출한 답, 정답 여부, 멈춘 시간·지운 흔적 | `/data/app.db` |
| 교사 이름·아이디·비밀번호(해시) | `/data/app.db` |
| 올린 문제 파일·사진 (PDF·hwpx·이미지, 손글씨 즉석 문제) | `/data/uploads/` |

배포 전에 확인할 것:

- **학교·교육청 규정 확인**: 학생 개인정보를 외부(국외) 클라우드에 저장해도 되는지, 학부모 동의나 개인정보 처리 안내가 필요한지 학교 정보보호 담당자에게 먼저 확인하세요. 「개인정보 보호법」상 국외 이전에 해당할 수 있습니다.
- **최소한의 정보만**: 학생 이름은 성 + 이름 첫 글자 등으로 줄여 넣어도 동작에는 문제가 없습니다.
- **비밀번호**: 관리자 기본 비밀번호(`admin1234`)를 절대 그대로 두지 마세요. `ADMIN_PASSWORD`를 긴 값으로 지정하고, 첫 로그인 후 다시 바꾸세요.
- **접근 권한**: 클라우드 계정에 접근할 수 있는 사람은 DB 파일 전체(위 표의 모든 정보)를 내려받을 수 있습니다. 계정에 2단계 인증을 켜 두세요.
- **삭제**: 학년도가 끝나면 필요 없는 학급·학생을 지우고, 서비스를 그만 쓸 때는 앱과 **볼륨까지** 삭제하세요(앱만 지우면 볼륨이 남는 경우가 있습니다).
- **백업 보관**: 백업 파일에도 같은 개인정보가 들어 있으니 학교 PC 등 안전한 곳에만 보관하세요.

## 공통 사항

- 데이터는 모두 `/data` 폴더 하나에 있습니다(`app.db` + `uploads/`). **`/data`에 영구 디스크를 연결하지 않으면 재배포·재시작할 때 모든 데이터가 사라집니다.**
- 실시간 연결(WebSocket)과 SQLite 파일을 쓰므로 **서버는 반드시 1대**로 운영하세요. 늘리면 학생 화면과 교사 화면이 다른 서버에 붙어 실시간이 깨집니다.
- 환경변수는 [`.env.example`](.env.example)을 참고하세요. 꼭 넣어야 하는 값은 `ADMIN_PASSWORD` 하나입니다.
- 상태 확인 주소: `/healthz` (정상이면 `ok`).

## 로컬에서 먼저 확인 (선택)

```bash
cd math-class
docker build -t math-class .
docker run --rm -p 3000:3000 -v math-data:/data -e ADMIN_PASSWORD=긴비밀번호 math-class
# → http://localhost:3000
```

## 방법 1. Fly.io

설정 파일: [`fly.toml`](fly.toml). 도쿄(`nrt`) 리전, 1GB 볼륨, 512MB 머신 1대, HTTPS 강제.

1. [flyctl 설치](https://fly.io/docs/flyctl/install/) 후 로그인: `fly auth login` (계정·결제 수단 필요)
2. 앱 만들기 (배포는 아직 안 함). `fly.toml`의 `app` 이름을 유일한 이름으로 바꾸라는 안내가 나옵니다.
   ```bash
   cd math-class
   fly launch --no-deploy --copy-config
   ```
3. 영구 디스크 만들기 (이름은 `fly.toml`의 `[mounts] source`와 같아야 함):
   ```bash
   fly volumes create math_data --region nrt --size 1
   ```
4. 관리자 비밀번호 넣기 (암호화되어 저장되고 `fly.toml`에는 남지 않음):
   ```bash
   fly secrets set ADMIN_PASSWORD='긴비밀번호' ADMIN_ID=admin
   ```
5. 배포: `fly deploy` → `https://<앱이름>.fly.dev` 로 접속
6. 머신이 1대인지 확인: `fly scale show` (2대면 `fly scale count 1`)

참고
- `auto_stop_machines = "off"`라서 계속 켜져 있습니다(수업 중 끊김 방지). 비용을 줄이려면 `fly.toml` 주석을 참고해 `"stop"`으로 바꿀 수 있습니다.
- 볼륨 스냅샷은 Fly가 매일 자동으로 만들고 며칠간 보관합니다: `fly volumes snapshots list <볼륨ID>`.
- 학교 도메인을 쓰려면 `fly certs add 도메인` 후 DNS를 설정하세요.

## 방법 2. Railway

설정 파일: [`railway.json`](railway.json). Dockerfile 빌드, 인스턴스 1개, `/healthz` 상태 확인.

1. [railway.com](https://railway.com)에서 계정을 만들고 GitHub를 연결합니다(볼륨은 유료 플랜 필요할 수 있음).
2. **New Project → Deploy from GitHub repo** 에서 이 저장소를 고릅니다.
3. 서비스 **Settings**
   - **Root Directory**: `math-class` (앱이 하위 폴더에 있으므로 꼭 지정)
   - **Config-as-code** 경로가 `math-class/railway.json`인지 확인 (Root Directory를 지정하면 보통 자동 인식)
   - **Region**: 가까운 아시아 리전(예: Singapore)
4. 서비스에서 **Volume 추가** → Mount path `/data`
5. **Variables** 에 `ADMIN_PASSWORD`(긴 값), 필요하면 `ADMIN_ID`. `PORT`는 Railway가 자동으로 넣습니다.
6. **Settings → Networking → Generate Domain** 을 누르면 `https://<이름>.up.railway.app` 주소가 생깁니다.
7. Replicas가 1인지 확인합니다(`railway.json`에 1로 지정됨).

참고
- Dockerfile에 `VOLUME` 지시어를 쓰면 Railway 빌드가 실패하므로 넣지 않았습니다. 볼륨은 위 4번처럼 Railway 화면에서 연결합니다.
- Railway 볼륨 백업은 서비스의 Volume → Backups 에서 설정할 수 있습니다(플랜에 따라 다름).

## 백업과 복원

가장 확실한 방법은 `/data` 폴더를 통째로 복사하는 것입니다. 백업 전에 수업이 진행 중이 아닌지 확인하세요.

- **Fly.io**
  ```bash
  fly ssh console -C "tar czf /tmp/backup.tgz -C /data ."
  fly ssh sftp get /tmp/backup.tgz ./math-class-backup-$(date +%Y%m%d).tgz
  ```
- **Railway**: `railway ssh` 로 들어가 같은 `tar` 명령을 쓰거나, Volume Backups 기능을 사용합니다.
- 복원: 새 볼륨의 `/data`에 압축을 풀고 앱을 재시작합니다.

## 업데이트

- Fly.io: 코드를 받은 뒤 `fly deploy`. 볼륨 데이터는 그대로 유지됩니다.
- Railway: 연결된 브랜치에 push 하면 자동으로 다시 배포됩니다.
- DB 스키마는 시작할 때 `CREATE TABLE IF NOT EXISTS`로 맞추므로 따로 마이그레이션 명령이 필요 없습니다.
