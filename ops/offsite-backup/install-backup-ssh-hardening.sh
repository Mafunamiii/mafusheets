#!/bin/sh
set -eu

ACCOUNT=mafusheets-backup
KEYS_DIR=/etc/ssh/authorized_keys
KEYS_FILE=$KEYS_DIR/$ACCOUNT
SSHD_DROPIN=/etc/ssh/sshd_config.d/90-mafusheets-backup.conf
SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
POLICY_SOURCE=$SOURCE_DIR/90-mafusheets-backup-sshd.conf

usage() {
    echo "usage: sudo $0 /path/to/production-backup.pub" >&2
    echo "       sudo $0 --rollback /etc/ssh/mafusheets-backup-rollback/SNAPSHOT" >&2
    exit 64
}

[ "$(id -u)" -eq 0 ] || {
    echo "must run as root" >&2
    exit 77
}
command -v sshd >/dev/null 2>&1 || {
    echo "sshd is not installed" >&2
    exit 69
}
command -v rrsync >/dev/null 2>&1 || {
    echo "rrsync is required; install the Debian rsync package" >&2
    exit 69
}
rrsync -h 2>&1 | grep -q -- '-no-overwrite' || {
    echo "this rrsync does not support required -no-overwrite mode" >&2
    exit 69
}

restore_snapshot() {
    snapshot=$1
    for item in "authorized_keys:$KEYS_FILE" "sshd_dropin:$SSHD_DROPIN"; do
        name=${item%%:*}
        destination=${item#*:}
        if [ "$(cat "$snapshot/$name.state")" = present ]; then
            cp -a -- "$snapshot/$name" "$destination"
        else
            rm -f -- "$destination"
        fi
    done
}

if [ "$#" -eq 2 ] && [ "$1" = --rollback ]; then
    rollback_dir=$2
    case "$rollback_dir" in
        /etc/ssh/mafusheets-backup-rollback/*) ;;
        *) echo "invalid rollback directory" >&2; exit 65 ;;
    esac
    [ -f "$rollback_dir/authorized_keys.state" ] &&
        [ -f "$rollback_dir/sshd_dropin.state" ] || {
        echo "invalid rollback snapshot" >&2
        exit 65
    }
    restore_snapshot "$rollback_dir"
    sshd -t
    sshd -T -C user="$ACCOUNT",host=localhost,addr=127.0.0.1 >/dev/null
    echo "SSH files restored and validated; run: sudo systemctl reload ssh"
    exit 0
fi

[ "$#" -eq 1 ] || usage
PUBLIC_KEY=$1
[ -f "$PUBLIC_KEY" ] || {
    echo "public key does not exist: $PUBLIC_KEY" >&2
    exit 66
}
[ -f "$POLICY_SOURCE" ] || {
    echo "missing SSH policy: $POLICY_SOURCE" >&2
    exit 66
}

account_entry=$(getent passwd "$ACCOUNT") || {
    echo "account does not exist: $ACCOUNT" >&2
    exit 67
}
account_home=$(printf '%s\n' "$account_entry" | cut -d: -f6)
case "$account_home" in
    /home/*|/var/lib/*) ;;
    *) echo "refusing unexpected account home: $account_home" >&2; exit 65 ;;
esac
[ -d "$account_home" ] || {
    echo "account home does not exist: $account_home" >&2
    exit 72
}

first_field=$(awk 'NF && $1 !~ /^#/ { print $1; exit }' "$PUBLIC_KEY")
case "$first_field" in
    ssh-ed25519|sk-ssh-ed25519@openssh.com) ;;
    *) echo "backup key must be an Ed25519 public key" >&2; exit 65 ;;
esac

backup_dir=/etc/ssh/mafusheets-backup-rollback/$(date -u +%Y%m%dT%H%M%SZ)-$$
install -d -o root -g root -m 0700 "$backup_dir"

save_existing() {
    source_path=$1
    backup_name=$2
    if [ -e "$source_path" ]; then
        cp -a -- "$source_path" "$backup_dir/$backup_name"
        printf 'present\n' >"$backup_dir/$backup_name.state"
    else
        printf 'absent\n' >"$backup_dir/$backup_name.state"
    fi
}
save_existing "$KEYS_FILE" authorized_keys
save_existing "$SSHD_DROPIN" sshd_dropin

on_failure() {
    status=$?
    trap - EXIT HUP INT TERM
    restore_snapshot "$backup_dir"
    echo "installation failed; SSH files restored from $backup_dir" >&2
    exit "$status"
}
trap on_failure EXIT HUP INT TERM

# The account may execute the forced command, but must not alter login policy.
chown root:root "$account_home"
chmod 0755 "$account_home"
if [ -e "$account_home/.ssh" ]; then
    chown -R root:root "$account_home/.ssh"
    find "$account_home/.ssh" -type d -exec chmod 0700 {} \;
    find "$account_home/.ssh" -type f -exec chmod 0600 {} \;
fi
find "$account_home" -maxdepth 1 -type f \
    \( -name '.profile' -o -name '.bash_profile' -o -name '.bash_login' \
       -o -name '.bashrc' -o -name '.bash_logout' -o -name '.zprofile' \
       -o -name '.zshrc' -o -name '.zlogin' -o -name '.zlogout' \
       -o -name '.kshrc' -o -name '.sshrc' \) \
    -exec chown root:root {} \; -exec chmod go-w {} \;

install -d -o root -g root -m 0755 "$KEYS_DIR"
key_tmp=$(mktemp "$KEYS_DIR/.${ACCOUNT}.XXXXXX")
policy_tmp=$(mktemp /etc/ssh/sshd_config.d/.90-mafusheets-backup.XXXXXX)
trap 'rm -f -- "$key_tmp" "$policy_tmp"; on_failure' EXIT HUP INT TERM

{
    printf '%s' 'restrict,command="/usr/bin/rrsync -wo -no-del -no-overwrite -munge /var/spool/mafusheets-backup/incoming" '
    awk 'NF && $1 !~ /^#/ { print; exit }' "$PUBLIC_KEY"
} >"$key_tmp"
chown root:root "$key_tmp"
chmod 0600 "$key_tmp"
install -o root -g root -m 0644 "$POLICY_SOURCE" "$policy_tmp"
mv -f -- "$key_tmp" "$KEYS_FILE"
mv -f -- "$policy_tmp" "$SSHD_DROPIN"

# Validate the complete server configuration, including all included files.
sshd -t
sshd -T -C user="$ACCOUNT",host=localhost,addr=127.0.0.1 >/dev/null

trap - EXIT HUP INT TERM
echo "SSH hardening installed and validated."
echo "SSH has NOT been reloaded. Keep the current admin session open and run:"
echo "  sudo systemctl reload ssh"
echo "Rollback snapshot: $backup_dir"
echo "Rollback with:"
echo "  sudo $0 --rollback $backup_dir"
