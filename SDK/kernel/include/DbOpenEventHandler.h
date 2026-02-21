#pragma once


namespace kernel::extensions
{
  /// <summary>
  /// Event handler interface for the DbOpen event which may be implemented by a COMOS kernel extension to react upon database switches. 
  /// </summary>
  class DbOpenEventHandler
  {
  public:
    virtual void OnDbOpen(const std::wstring& connectionString, const std::wstring& taggedDataSource) = 0;

  protected:
    // This will prevent deletion from outside, through an interface pointer
    // It must be virtual due to possible multiple inheritance when implementing multiple interfaces
    virtual ~DbOpenEventHandler() = default;
  };
}