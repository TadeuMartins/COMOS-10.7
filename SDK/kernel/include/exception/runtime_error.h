#pragma  once


namespace kernel::exception
{
  /// <summary>Generic exception class which accepts a wide string as error message and is derived from 
  //           the standard C++ exception class</summary>
  ///
  /// <history>BKA 09.07.2014  1072621  created</history>
  ///
  class runtime_error : public std::exception
  {
  public:
    // methods
    runtime_error(std::wstring errorMessage, std::source_location sourceLocation = std::source_location::current());
    runtime_error(const _com_error& e, std::source_location sourceLocation = std::source_location::current());
    ~runtime_error() override = default;

    std::wstring GetMessage() const;
    std::wstring GetMessageWithoutLocation() const;
    std::wstring GetLocation() const;

    const char* what() const override;

  private:
    // data members
    std::source_location m_sourceLocation;
    std::wstring m_errorMessage;
    mutable std::string m_what;
  };
}
