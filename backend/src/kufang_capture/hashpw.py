import getpass

from argon2 import PasswordHasher


def main() -> None:
    password = getpass.getpass("Password: ")
    if not password:
        raise SystemExit("Password must not be empty")
    print(PasswordHasher().hash(password))


if __name__ == "__main__":
    main()
