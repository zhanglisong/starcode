#!/usr/bin/env python3
"""
Echo - A simple command that prints its arguments.
Similar to Unix echo command.
"""

import sys


def echo(*args, separator=' ', end='\n'):
    """
    Print arguments to standard output.
    
    Args:
        *args: Values to print
        separator: String inserted between values (default: space)
        end: String appended after last value (default: newline)
    """
    print(*args, sep=separator, end=end)


def main():
    """Main entry point for command-line usage."""
    # Skip script name, print all arguments separated by space
    args = sys.argv[1:]
    
    if not args:
        # No arguments, just print newline
        print()
    else:
        echo(*args)


if __name__ == '__main__':
    main()
