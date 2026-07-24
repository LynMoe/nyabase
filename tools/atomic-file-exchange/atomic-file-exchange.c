#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef RENAME_EXCHANGE
#define RENAME_EXCHANGE (1U << 1)
#endif

enum { EXIT_USAGE = 64, EXIT_UNSAFE = 65, EXIT_SYSTEM = 66 };

static int fail(int code, const char *message) {
  fprintf(stderr, "nyabase-atomic-file-exchange: %s\n", message);
  return code;
}

static int same_inode(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino;
}

static int split_path(const char *input, char *directory, size_t directory_size,
                      const char **name) {
  if (!input || input[0] != '/' || strlen(input) >= PATH_MAX) return -1;
  const char *slash = strrchr(input, '/');
  if (!slash || !slash[1] || !strcmp(slash + 1, ".") || !strcmp(slash + 1, "..")) return -1;
  size_t length = slash == input ? 1U : (size_t)(slash - input);
  if (length >= directory_size) return -1;
  memcpy(directory, input, length);
  directory[length] = '\0';
  *name = slash + 1;
  return 0;
}

static int exchange_paths(const char *left, const char *right) {
  char left_directory[PATH_MAX], right_directory[PATH_MAX];
  char canonical_directory[PATH_MAX];
  const char *left_name = NULL, *right_name = NULL;
  if (split_path(left, left_directory, sizeof(left_directory), &left_name) != 0 ||
      split_path(right, right_directory, sizeof(right_directory), &right_name) != 0 ||
      strcmp(left_directory, right_directory) != 0 || !strcmp(left_name, right_name)) {
    return fail(EXIT_UNSAFE, "paths must be distinct absolute entries in one directory");
  }
  if (!realpath(left_directory, canonical_directory) ||
      strcmp(canonical_directory, left_directory) != 0) {
    return fail(EXIT_UNSAFE, "parent directory is not canonical");
  }

  int directory_fd = open(left_directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory_fd < 0) return fail(EXIT_SYSTEM, "cannot open parent directory");
  int left_fd = openat(directory_fd, left_name, O_PATH | O_NOFOLLOW | O_CLOEXEC);
  int right_fd = openat(directory_fd, right_name, O_PATH | O_NOFOLLOW | O_CLOEXEC);
  struct stat left_before, right_before, left_after, right_after;
  if (left_fd < 0 || right_fd < 0 || fstat(left_fd, &left_before) != 0 ||
      fstat(right_fd, &right_before) != 0 || !S_ISREG(left_before.st_mode) ||
      !S_ISREG(right_before.st_mode) || left_before.st_nlink != 1 || right_before.st_nlink != 1 ||
      left_before.st_uid != 0 || left_before.st_gid != 0 ||
      right_before.st_uid != 0 || right_before.st_gid != 0 ||
      (left_before.st_mode & 0022) || (right_before.st_mode & 0022)) {
    if (left_fd >= 0) close(left_fd);
    if (right_fd >= 0) close(right_fd);
    close(directory_fd);
    return fail(EXIT_UNSAFE, "entries must be root-owned safe single-link regular files");
  }

  if (syscall(SYS_renameat2, directory_fd, left_name, directory_fd, right_name,
              RENAME_EXCHANGE) != 0) {
    close(left_fd); close(right_fd); close(directory_fd);
    return fail(EXIT_SYSTEM, "renameat2(RENAME_EXCHANGE) failed");
  }
  int new_left_fd = openat(directory_fd, left_name, O_PATH | O_NOFOLLOW | O_CLOEXEC);
  int new_right_fd = openat(directory_fd, right_name, O_PATH | O_NOFOLLOW | O_CLOEXEC);
  if (new_left_fd < 0 || new_right_fd < 0 || fstat(new_left_fd, &left_after) != 0 ||
      fstat(new_right_fd, &right_after) != 0 || !same_inode(&left_after, &right_before) ||
      !same_inode(&right_after, &left_before) || fsync(directory_fd) != 0) {
    if (new_left_fd >= 0) close(new_left_fd);
    if (new_right_fd >= 0) close(new_right_fd);
    close(left_fd); close(right_fd); close(directory_fd);
    return fail(EXIT_SYSTEM, "post-exchange identity or durability verification failed");
  }
  close(new_left_fd); close(new_right_fd);
  close(left_fd); close(right_fd); close(directory_fd);
  return 0;
}

static int write_all(int fd, const char *value) {
  size_t remaining = strlen(value);
  while (remaining) {
    ssize_t written = write(fd, value, remaining);
    if (written <= 0) return -1;
    value += written;
    remaining -= (size_t)written;
  }
  return fsync(fd);
}

static int self_test(const char *scratch) {
  char canonical[PATH_MAX], template[PATH_MAX], left[PATH_MAX], right[PATH_MAX], bytes[2];
  if (!scratch) scratch = "/tmp";
  if (scratch[0] != '/' || !realpath(scratch, canonical) || strcmp(canonical, scratch) != 0 ||
      snprintf(template, sizeof(template), "%s/.nyabase-exchange-probe-XXXXXX", scratch) >= (int)sizeof(template))
    return fail(EXIT_UNSAFE, "self-test directory must be canonical and absolute");
  char *directory = mkdtemp(template);
  if (!directory) return fail(EXIT_SYSTEM, "cannot create self-test directory");
  snprintf(left, sizeof(left), "%s/left", directory);
  snprintf(right, sizeof(right), "%s/right", directory);
  int left_fd = open(left, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
  int right_fd = open(right, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
  int result = EXIT_SYSTEM;
  if (left_fd >= 0 && right_fd >= 0 && write_all(left_fd, "L") == 0 &&
      write_all(right_fd, "R") == 0) {
    close(left_fd); close(right_fd); left_fd = right_fd = -1;
    if (exchange_paths(left, right) == 0) {
      left_fd = open(left, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
      right_fd = open(right, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
      if (left_fd >= 0 && right_fd >= 0 && read(left_fd, &bytes[0], 1) == 1 &&
          read(right_fd, &bytes[1], 1) == 1 && bytes[0] == 'R' && bytes[1] == 'L') result = 0;
    }
  }
  if (left_fd >= 0) close(left_fd);
  if (right_fd >= 0) close(right_fd);
  unlink(left); unlink(right); rmdir(directory);
  return result == 0 ? 0 : fail(EXIT_SYSTEM, "real renameat2 self-test failed");
}

int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--self-test")) return self_test(NULL);
  if (argc == 3 && !strcmp(argv[1], "--self-test")) return self_test(argv[2]);
  if (argc == 3) return exchange_paths(argv[1], argv[2]);
  return fail(EXIT_USAGE, "usage: BINARY LEFT RIGHT | BINARY --self-test [SCRATCH_DIR]");
}
